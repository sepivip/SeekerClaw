package com.seekerclaw.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.config.EnvVar
import com.seekerclaw.app.config.EnvVarRegistry
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.SectionLabel
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** State held by [EnvVarsScreen] to control which dialog is open. */
sealed class EnvVarDialogState {
    data object Hidden : EnvVarDialogState()
    data class Add(val prefillName: String = "") : EnvVarDialogState()
    data class Edit(val existing: EnvVar) : EnvVarDialogState()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EnvVarsScreen(
    onBack: () -> Unit,
    prefillKey: String? = null,
) {
    val context = LocalContext.current
    var envVars by remember { mutableStateOf(emptyList<EnvVar>()) }
    var dialogState by remember { mutableStateOf<EnvVarDialogState>(EnvVarDialogState.Hidden) }
    var showPasteDialog by remember { mutableStateOf(false) }
    var deleteTarget by remember { mutableStateOf<EnvVar?>(null) }
    // Observe EnvVarRegistry.keys so the list recomposes when vars are added/deleted externally.
    @Suppress("UNUSED_VARIABLE")
    val envKeys by EnvVarRegistry.keys.collectAsState()

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    // Load env vars off main thread (Keystore decrypt + JSON parse)
    val configVer by ConfigManager.configVersion
    LaunchedEffect(configVer) {
        envVars = withContext(Dispatchers.IO) {
            ConfigManager.loadEnvVars(context)
        }
        EnvVarRegistry.refreshFromConfig(context)
    }

    // Open Add dialog pre-filled when navigated with a prefillKey query param
    LaunchedEffect(prefillKey) {
        if (!prefillKey.isNullOrBlank() && dialogState is EnvVarDialogState.Hidden) {
            dialogState = EnvVarDialogState.Add(prefillName = prefillKey)
        }
    }

    // No manual refresh: ConfigManager.saveEnvVars bumps configVersion, which triggers
    // the LaunchedEffect(configVer) above to re-load envVars + refresh the registry.

    val onSave: (EnvVar) -> Unit = { newVar ->
        val updated = when (val s = dialogState) {
            is EnvVarDialogState.Edit -> envVars.map { if (it.name == s.existing.name) newVar else it }
            else -> envVars + newVar
        }
        ConfigManager.saveEnvVars(context, updated)
        dialogState = EnvVarDialogState.Hidden
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "Env Vars",
                        fontFamily = RethinkSans,
                        fontSize = 18.sp,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.TextPrimary,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back",
                            tint = SeekerClawColors.TextPrimary,
                        )
                    }
                },
                actions = {
                    IconButton(onClick = { dialogState = EnvVarDialogState.Add() }) {
                        Icon(
                            imageVector = Icons.Default.Add,
                            contentDescription = "Add env var",
                            tint = SeekerClawColors.TextPrimary,
                        )
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = SeekerClawColors.Background,
                ),
            )
        },
        containerColor = SeekerClawColors.Background,
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 20.dp, vertical = 8.dp)
                .verticalScroll(rememberScrollState()),
        ) {
            SectionLabel("Environment Variables")
            Spacer(modifier = Modifier.height(10.dp))

            // Header / summary card
            CardSurface {
                if (envVars.isEmpty()) {
                    Text(
                        text = "Env vars let your agent access API keys and secrets that skills require. " +
                            "Values are encrypted on-device and injected into the Node.js process at startup.",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextDim,
                    )
                } else {
                    val skillCount = envVars
                        .flatMap { EnvVarRegistry.skillsForKey(it.name) }
                        .toSet()
                        .size
                    Text(
                        text = "${envVars.size} var${if (envVars.size != 1) "s" else ""} set" +
                            if (skillCount > 0) " \u00b7 used by $skillCount skill${if (skillCount != 1) "s" else ""}" else "",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = SeekerClawColors.TextSecondary,
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                TextButton(
                    onClick = { showPasteDialog = true },
                    contentPadding = PaddingValues(0.dp),
                ) {
                    Text(
                        text = "Paste .env file",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextInteractive,
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            if (envVars.isEmpty()) {
                // Empty state
                CardSurface {
                    Column(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            text = "No env vars yet.",
                            fontFamily = RethinkSans,
                            fontSize = 14.sp,
                            fontWeight = FontWeight.Medium,
                            color = SeekerClawColors.TextPrimary,
                        )
                        Text(
                            text = "Tap + to add your first, or paste a .env file.",
                            fontFamily = RethinkSans,
                            fontSize = 13.sp,
                            color = SeekerClawColors.TextDim,
                            fontStyle = FontStyle.Italic,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        Spacer(modifier = Modifier.height(16.dp))
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            Button(
                                onClick = { dialogState = EnvVarDialogState.Add() },
                                shape = shape,
                                colors = ButtonDefaults.buttonColors(
                                    containerColor = SeekerClawColors.ActionPrimary,
                                    contentColor = Color.White,
                                ),
                            ) {
                                Icon(
                                    imageVector = Icons.Default.Add,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                                Text(
                                    text = "Add",
                                    fontFamily = RethinkSans,
                                    fontSize = 14.sp,
                                    modifier = Modifier.padding(start = 4.dp),
                                )
                            }
                            TextButton(onClick = { showPasteDialog = true }) {
                                Text(
                                    text = "Paste .env",
                                    fontFamily = RethinkSans,
                                    fontSize = 14.sp,
                                    color = SeekerClawColors.TextInteractive,
                                )
                            }
                        }
                    }
                }
            } else {
                // Env var list
                CardSurface {
                    for ((index, envVar) in envVars.withIndex()) {
                        val usedBy = EnvVarRegistry.skillsForKey(envVar.name)
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(vertical = 6.dp),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(
                                    text = envVar.name,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = SeekerClawColors.TextPrimary,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                Text(
                                    text = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    color = SeekerClawColors.TextDim,
                                )
                                if (usedBy.isNotEmpty()) {
                                    Row(
                                        modifier = Modifier.padding(top = 4.dp),
                                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                                    ) {
                                        usedBy.take(3).forEach { skill ->
                                            AssistChip(
                                                onClick = {},
                                                label = {
                                                    Text(
                                                        text = skill,
                                                        fontFamily = RethinkSans,
                                                        fontSize = 10.sp,
                                                        maxLines = 1,
                                                        overflow = TextOverflow.Ellipsis,
                                                    )
                                                },
                                                colors = AssistChipDefaults.assistChipColors(
                                                    containerColor = SeekerClawColors.Surface,
                                                    labelColor = SeekerClawColors.TextDim,
                                                ),
                                                modifier = Modifier.height(24.dp),
                                            )
                                        }
                                        if (usedBy.size > 3) {
                                            Text(
                                                text = "+${usedBy.size - 3} more",
                                                fontFamily = RethinkSans,
                                                fontSize = 10.sp,
                                                color = SeekerClawColors.TextDim,
                                                modifier = Modifier.align(Alignment.CenterVertically),
                                            )
                                        }
                                    }
                                }
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                IconButton(onClick = { dialogState = EnvVarDialogState.Edit(envVar) }) {
                                    Icon(
                                        imageVector = Icons.Default.Edit,
                                        contentDescription = "Edit ${envVar.name}",
                                        tint = SeekerClawColors.TextDim,
                                    )
                                }
                                IconButton(onClick = { deleteTarget = envVar }) {
                                    Icon(
                                        imageVector = Icons.Default.Delete,
                                        contentDescription = "Delete ${envVar.name}",
                                        tint = SeekerClawColors.Error,
                                    )
                                }
                            }
                        }
                        if (index < envVars.lastIndex) {
                            HorizontalDivider(
                                color = SeekerClawColors.BorderSubtle.copy(alpha = 0.3f),
                            )
                        }
                    }
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Restart banner
                CardSurface {
                    Text(
                        text = "Restart the service from the Dashboard to apply changes.",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
            }

            Spacer(modifier = Modifier.height(20.dp))
        }
    }

    // Edit / Add dialog
    if (dialogState !is EnvVarDialogState.Hidden) {
        EnvVarEditDialog(
            state = dialogState,
            existingKeys = envVars.map { it.name }.toSet(),
            onDismiss = { dialogState = EnvVarDialogState.Hidden },
            onSave = onSave,
        )
    }

    // Paste dialog
    if (showPasteDialog) {
        EnvVarPasteDialog(
            existingKeys = envVars.map { it.name }.toSet(),
            onDismiss = { showPasteDialog = false },
            onApply = { newVars ->
                // associateBy keeps the LAST occurrence — pasted newVars overwrite
                // existing entries with the same name. This matches the paste preview
                // which counts "will overwrite" rows; distinctBy {} would silently
                // drop the user's intended overwrite.
                val merged = (envVars + newVars).associateBy { it.name }.values.toList()
                ConfigManager.saveEnvVars(context, merged)
                showPasteDialog = false
            },
        )
    }

    // Delete confirmation dialog
    deleteTarget?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteTarget = null },
            title = {
                Text(
                    text = "Delete Env Var",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
            },
            text = {
                val affectedSkills = EnvVarRegistry.skillsForKey(target.name)
                val body = if (affectedSkills.isEmpty()) {
                    "Delete \"${target.name}\"? This cannot be undone."
                } else {
                    val skillWord = if (affectedSkills.size == 1) "skill" else "skills"
                    val preview = affectedSkills.take(3).joinToString(", ")
                    val suffix = if (affectedSkills.size > 3) ", +${affectedSkills.size - 3} more" else ""
                    "Delete \"${target.name}\"? Required by ${affectedSkills.size} $skillWord: $preview$suffix. These will stop working until the var is re-added."
                }
                Text(
                    text = body,
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextSecondary,
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    ConfigManager.saveEnvVars(context, envVars.filterNot { it.name == target.name })
                    deleteTarget = null
                }) {
                    Text(
                        text = "Delete",
                        fontFamily = RethinkSans,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.Error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { deleteTarget = null }) {
                    Text("Cancel", fontFamily = RethinkSans, color = SeekerClawColors.TextDim)
                }
            },
            containerColor = SeekerClawColors.Surface,
            shape = shape,
        )
    }
}
