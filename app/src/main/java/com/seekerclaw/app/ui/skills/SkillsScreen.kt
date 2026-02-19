package com.seekerclaw.app.ui.skills

import androidx.activity.compose.BackHandler
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
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.PullToRefreshBox
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SkillsScreen() {
    val context = LocalContext.current
    val workspaceDir = remember { File(context.filesDir, "workspace") }
    var selectedSkill by remember { mutableStateOf<SkillInfo?>(null) }

    val skill = selectedSkill
    if (skill != null) {
        BackHandler { selectedSkill = null }
        SkillDetailScreen(
            skill = skill,
            onBack = { selectedSkill = null },
        )
    } else {
        SkillsListContent(
            workspaceDir = workspaceDir,
            onSkillClick = { selectedSkill = it },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SkillsListContent(
    workspaceDir: File,
    onSkillClick: (SkillInfo) -> Unit,
) {
    var skills by remember { mutableStateOf<List<SkillInfo>>(emptyList()) }
    var isRefreshing by remember { mutableStateOf(false) }
    var searchQuery by remember { mutableStateOf("") }
    val scope = rememberCoroutineScope()
    val shape = remember { RoundedCornerShape(SeekerClawColors.CornerRadius) }

    suspend fun loadSkills() {
        val loaded = withContext(Dispatchers.IO) { SkillsRepository.loadSkills(workspaceDir) }
        skills = loaded
    }

    LaunchedEffect(Unit) { loadSkills() }

    val filtered = remember(skills, searchQuery) {
        if (searchQuery.isEmpty()) skills
        else skills.filter { s ->
            s.name.contains(searchQuery, ignoreCase = true) ||
                s.description.contains(searchQuery, ignoreCase = true) ||
                s.triggers.any { it.contains(searchQuery, ignoreCase = true) }
        }
    }

    PullToRefreshBox(
        isRefreshing = isRefreshing,
        onRefresh = {
            scope.launch {
                isRefreshing = true
                loadSkills()
                isRefreshing = false
            }
        },
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
                Text(
                    text = "Skills (${skills.size})",
                    fontFamily = RethinkSans,
                    fontSize = 22.sp,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
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
                items(filtered, key = { it.filePath }) { skill ->
                    SkillCard(skill = skill, shape = shape, onClick = { onSkillClick(skill) })
                }
            }
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
private fun SkillCard(
    skill: SkillInfo,
    shape: RoundedCornerShape,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(shape)
                .background(SeekerClawColors.SurfaceHighlight),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = skill.emoji.ifEmpty { "⚡" },
                fontSize = 22.sp,
            )
        }
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
