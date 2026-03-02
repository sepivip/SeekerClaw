package com.seekerclaw.app.ui.skills

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.SubcomposeAsyncImage
import coil.request.ImageRequest
import com.seekerclaw.app.config.ConfigManager
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.Analytics
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

@Composable
fun SkillsScreen() {
    val context = LocalContext.current
    val workspaceDir = remember { File(context.filesDir, "workspace") }
    var selectedSkill by remember { mutableStateOf<SkillInfo?>(null) }

    // Single-skill export launcher (registered at screen level so it survives detail→list navigation)
    var pendingExportDirName by remember { mutableStateOf<String?>(null) }
    val singleSkillExportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("text/markdown")
    ) { uri ->
        val dirName = pendingExportDirName
        if (uri != null && dirName != null) {
            val success = ConfigManager.exportSkill(context, uri, dirName)
            Analytics.featureUsed("skill_exported")
            Toast.makeText(
                context,
                if (success) "Skill exported" else "Export failed",
                Toast.LENGTH_SHORT,
            ).show()
        }
        pendingExportDirName = null
    }

    val skill = selectedSkill
    if (skill != null) {
        BackHandler { selectedSkill = null }
        SkillDetailScreen(
            skill = skill,
            onBack = { selectedSkill = null },
            onExport = if (!skill.isDefault || skill.isModifiedDefault) {
                {
                    pendingExportDirName = skill.dirName
                    singleSkillExportLauncher.launch("${skill.dirName}.md")
                }
            } else null,
        )
    } else {
        SkillsListContent(
            workspaceDir = workspaceDir,
            onSkillClick = { selectedSkill = it },
        )
    }
}

@Composable
private fun SkillsListContent(
    workspaceDir: File,
    onSkillClick: (SkillInfo) -> Unit,
) {
    val context = LocalContext.current
    var skills by remember { mutableStateOf<List<SkillInfo>>(emptyList()) }
    var searchQuery by remember { mutableStateOf("") }
    var reloadTrigger by remember { mutableStateOf(0) }
    val shape = remember { RoundedCornerShape(SeekerClawColors.CornerRadius) }

    // Bulk export launcher
    val bulkExportLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.CreateDocument("application/zip")
    ) { uri ->
        if (uri != null) {
            val success = ConfigManager.exportUserSkills(context, uri)
            Analytics.featureUsed("skills_bulk_exported")
            Toast.makeText(
                context,
                if (success) "Skills exported" else "Export failed",
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    // Import skills launcher (accepts ZIP + .md)
    val importSkillsLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            val count = ConfigManager.importUserSkills(context, uri)
            Analytics.featureUsed("skills_imported")
            if (count > 0) {
                reloadTrigger++
                Toast.makeText(
                    context,
                    "Imported $count skill${if (count > 1) "s" else ""}",
                    Toast.LENGTH_SHORT,
                ).show()
            } else {
                Toast.makeText(
                    context,
                    if (count == 0) "No skills found in file" else "Import failed",
                    Toast.LENGTH_SHORT,
                ).show()
            }
        }
    }

    suspend fun loadSkills() {
        val loaded = withContext(Dispatchers.IO) {
            val defaultNames = ConfigManager.getDefaultSkillNames(context)
            val defaultHashes = ConfigManager.getDefaultSkillHashes(context)
            SkillsRepository.loadSkills(workspaceDir, defaultNames, defaultHashes)
        }
        skills = loaded
    }

    LaunchedEffect(reloadTrigger) { loadSkills() }

    val filtered = remember(skills, searchQuery) {
        if (searchQuery.isEmpty()) skills
        else skills.filter { s ->
            s.name.contains(searchQuery, ignoreCase = true) ||
                s.description.contains(searchQuery, ignoreCase = true) ||
                s.triggers.any { it.contains(searchQuery, ignoreCase = true) }
        }
    }

    val addedSkills = remember(filtered) { filtered.filter { !it.isDefault } }
    val defaultSkills = remember(filtered) { filtered.filter { it.isDefault } }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background),
    ) {
        LazyColumn(
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            item {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = if (searchQuery.isEmpty()) "Skills (${skills.size})"
                               else "Skills (${filtered.size} of ${skills.size})",
                        fontFamily = RethinkSans,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.TextPrimary,
                    )
                    Text(
                        text = "Import",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = SeekerClawColors.Accent,
                        modifier = Modifier
                            .clickable(onClickLabel = "Import skills") {
                                importSkillsLauncher.launch(arrayOf("*/*"))
                            }
                            .padding(4.dp),
                    )
                }
            }

            item {
                Spacer(Modifier.height(4.dp))
                SearchField(
                    query = searchQuery,
                    onQueryChange = { searchQuery = it },
                    shape = shape,
                )
            }

            item {
                MarketplaceTeaserCard(shape = shape)
            }

            if (filtered.isEmpty()) {
                item {
                    EmptySkillsState(isFiltered = searchQuery.isNotEmpty())
                }
            } else {
                // Added skills section
                if (addedSkills.isNotEmpty()) {
                    item {
                        SectionHeader(
                            title = "Added (${addedSkills.size})",
                            actionLabel = "Export All",
                            onAction = {
                                val timestamp = android.text.format.DateFormat.format(
                                    "yyyyMMdd", java.util.Date()
                                )
                                bulkExportLauncher.launch("seekerclaw_skills_$timestamp.zip")
                            },
                        )
                    }
                    items(addedSkills, key = { it.filePath }) { skill ->
                        SkillCard(skill = skill, shape = shape, onClick = { onSkillClick(skill) })
                    }
                }

                // Default skills section
                if (defaultSkills.isNotEmpty()) {
                    item {
                        SectionHeader(title = "Default (${defaultSkills.size})")
                    }
                    items(defaultSkills, key = { it.filePath }) { skill ->
                        SkillCard(skill = skill, shape = shape, onClick = { onSkillClick(skill) })
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(
    title: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 8.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = title,
            fontFamily = RethinkSans,
            fontSize = 13.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextDim,
            letterSpacing = 0.5.sp,
        )
        if (actionLabel != null && onAction != null) {
            Text(
                text = actionLabel,
                fontFamily = RethinkSans,
                fontSize = 12.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.Accent,
                modifier = Modifier
                    .clickable(onClickLabel = actionLabel, onClick = onAction)
                    .padding(4.dp),
            )
        }
    }
}

@Composable
private fun SearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    shape: RoundedCornerShape,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "⌕",
            fontFamily = FontFamily.Monospace,
            fontSize = 18.sp,
            color = SeekerClawColors.TextDim,
        )
        Spacer(Modifier.width(10.dp))
        Box(modifier = Modifier.weight(1f)) {
            if (query.isEmpty()) {
                Text(
                    text = "Search skills...",
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextDim,
                )
            }
            BasicTextField(
                value = query,
                onValueChange = onQueryChange,
                singleLine = true,
                cursorBrush = SolidColor(SeekerClawColors.Accent),
                textStyle = TextStyle(
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextPrimary,
                ),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (query.isNotEmpty()) {
            Spacer(Modifier.width(8.dp))
            Text(
                text = "✕",
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                color = SeekerClawColors.TextDim,
                modifier = Modifier.clickable(onClickLabel = "Clear search") { onQueryChange("") },
            )
        }
    }
}

@Composable
private fun MarketplaceTeaserCard(shape: RoundedCornerShape) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .padding(20.dp),
    ) {
        Column {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.Top,
            ) {
                Text(
                    text = "Skill Marketplace",
                    fontFamily = RethinkSans,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "COMING SOON",
                    fontFamily = RethinkSans,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                    modifier = Modifier
                        .background(
                            SeekerClawColors.Primary.copy(alpha = 0.12f),
                            RoundedCornerShape(4.dp),
                        )
                        .padding(horizontal = 8.dp, vertical = 4.dp),
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = "Discover and install skills created by the community.",
                fontFamily = RethinkSans,
                fontSize = 13.sp,
                color = SeekerClawColors.TextDim,
            )
        }
    }
}

@Composable
fun SkillAvatar(
    skill: SkillInfo,
    size: Int = 44,
    shape: RoundedCornerShape = RoundedCornerShape(SeekerClawColors.CornerRadius),
    emojiFontSize: Int = 22,
) {
    if (skill.imageUrl.isNotEmpty()) {
        SubcomposeAsyncImage(
            model = ImageRequest.Builder(LocalContext.current)
                .data(skill.imageUrl)
                .crossfade(true)
                .build(),
            contentDescription = skill.name,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .size(size.dp)
                .clip(shape),
            loading = {
                EmojiAvatar(
                    emoji = skill.emoji,
                    size = size,
                    shape = shape,
                    emojiFontSize = emojiFontSize,
                )
            },
            error = {
                EmojiAvatar(
                    emoji = skill.emoji,
                    size = size,
                    shape = shape,
                    emojiFontSize = emojiFontSize,
                )
            },
        )
    } else {
        EmojiAvatar(
            emoji = skill.emoji,
            size = size,
            shape = shape,
            emojiFontSize = emojiFontSize,
        )
    }
}

@Composable
private fun EmojiAvatar(
    emoji: String,
    size: Int,
    shape: RoundedCornerShape,
    emojiFontSize: Int,
) {
    Box(
        modifier = Modifier
            .size(size.dp)
            .clip(shape)
            .background(SeekerClawColors.SurfaceHighlight),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = emoji.ifEmpty { "⚡" },
            fontSize = emojiFontSize.sp,
        )
    }
}

@Composable
private fun SkillCard(
    skill: SkillInfo,
    shape: RoundedCornerShape,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .clickable(onClickLabel = "View ${skill.name}", onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SkillAvatar(skill = skill, size = 44, shape = shape)
        Spacer(Modifier.width(14.dp))
        Column(modifier = Modifier.weight(1f)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    text = skill.name,
                    fontFamily = RethinkSans,
                    fontSize = 15.sp,
                    fontWeight = FontWeight.Medium,
                    color = SeekerClawColors.TextPrimary,
                    modifier = Modifier.weight(1f),
                )
                if (skill.warnings.isNotEmpty()) {
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "⚠",
                        fontSize = 14.sp,
                        color = SeekerClawColors.Warning,
                    )
                }
                if (skill.version.isNotEmpty()) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        text = "v${skill.version.removePrefix("v").removePrefix("V")}",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
            }
            if (skill.description.isNotEmpty()) {
                Spacer(Modifier.height(3.dp))
                Text(
                    text = skill.description.lines().firstOrNull { it.isNotBlank() } ?: "",
                    fontFamily = RethinkSans,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextDim,
                    maxLines = 1,
                )
            }
            if (skill.triggers.isNotEmpty()) {
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(SeekerClawColors.Accent),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        text = "${skill.triggers.size} trigger${if (skill.triggers.size > 1) "s" else ""}",
                        fontFamily = RethinkSans,
                        fontSize = 11.sp,
                        color = SeekerClawColors.Accent,
                    )
                }
            }
        }
    }
}

@Composable
private fun EmptySkillsState(isFiltered: Boolean) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = if (isFiltered) "🔍" else "🧩",
            fontSize = 40.sp,
        )
        Spacer(Modifier.height(16.dp))
        Text(
            text = if (isFiltered) "No skills match your search"
            else "No skills installed",
            fontFamily = RethinkSans,
            fontSize = 16.sp,
            fontWeight = FontWeight.Medium,
            color = SeekerClawColors.TextPrimary,
        )
        Spacer(Modifier.height(8.dp))
        Text(
            text = if (isFiltered) "Try a different search term"
            else "Send a .md skill file via Telegram to install your first skill.",
            fontFamily = RethinkSans,
            fontSize = 13.sp,
            color = SeekerClawColors.TextDim,
        )
    }
}
