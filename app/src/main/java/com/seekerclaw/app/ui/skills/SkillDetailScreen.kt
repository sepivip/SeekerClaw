package com.seekerclaw.app.ui.skills

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.InCardLabel
import com.seekerclaw.app.ui.components.ScreenActionLink
import com.seekerclaw.app.ui.components.SeekerClawScaffold
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Spacing
import com.seekerclaw.app.ui.theme.TypeScale

/**
 * BAT-1247: the bare `missing "version"` diagnostic from SkillsRepository is
 * mapped to an actionable one-liner AT RENDER — the repository string (and
 * every other diagnostic) stays untouched.
 */
private const val MISSING_VERSION_RAW = "missing \"version\""
private const val MISSING_VERSION_FRIENDLY =
    "Missing \"version\" in SKILL.md frontmatter — the skill still works; add a version field to silence this."

@Composable
fun SkillDetailScreen(
    skill: SkillInfo,
    onBack: () -> Unit,
    onExport: (() -> Unit)? = null,
) {
    SeekerClawScaffold(title = skill.name, onBack = onBack) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.lg, vertical = Spacing.lg),
            verticalArrangement = Arrangement.spacedBy(Spacing.lg),
        ) {
            // Header row: avatar + name + version, with the green screen-level Export action
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                SkillAvatar(skill = skill, size = 56, emojiFontSize = 32)
                Spacer(Modifier.width(Spacing.lg))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = skill.name,
                        fontFamily = RethinkSans,
                        fontSize = TypeScale.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.TextPrimary,
                    )
                    if (skill.version.isNotEmpty()) {
                        Spacer(Modifier.height(Spacing.xxs))
                        Text(
                            text = "v${skill.version.removePrefix("v").removePrefix("V")}",
                            fontFamily = FontFamily.Monospace,
                            fontSize = TypeScale.labelSmall,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                }
                if (onExport != null) {
                    Spacer(Modifier.width(Spacing.md))
                    ScreenActionLink(label = "Export", onClick = onExport)
                }
            }

            // Type
            InfoSection(label = "TYPE") {
                Text(
                    text = if (skill.isDefault) "Default (bundled)" else "Added by user",
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextPrimary,
                )
            }

            // Description
            if (skill.description.isNotEmpty()) {
                InfoSection(label = "DESCRIPTION") {
                    Text(
                        text = skill.description,
                        fontFamily = RethinkSans,
                        fontSize = 14.sp,
                        color = SeekerClawColors.TextPrimary,
                        lineHeight = 22.sp,
                    )
                }
            }

            // Triggers
            InfoSection(label = "TRIGGERS") {
                if (skill.triggers.isEmpty()) {
                    Text(
                        text = "Semantic — AI picks this skill based on description",
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        color = SeekerClawColors.TextDim,
                    )
                } else {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        skill.triggers.forEach { trigger ->
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Box(
                                    modifier = Modifier
                                        .size(6.dp)
                                        .clip(CircleShape)
                                        .background(SeekerClawColors.Accent),
                                )
                                Spacer(Modifier.width(10.dp))
                                Text(
                                    text = trigger,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 13.sp,
                                    color = SeekerClawColors.TextPrimary,
                                )
                            }
                        }
                    }
                }
            }

            // Diagnostics
            if (skill.warnings.isNotEmpty()) {
                InfoSection(label = "DIAGNOSTICS") {
                    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        skill.warnings.forEach { warning ->
                            Row(verticalAlignment = Alignment.Top) {
                                Text(
                                    text = "⚠",
                                    fontSize = 13.sp,
                                    color = SeekerClawColors.Warning,
                                )
                                Spacer(Modifier.width(8.dp))
                                Text(
                                    text = if (warning == MISSING_VERSION_RAW) MISSING_VERSION_FRIENDLY else warning,
                                    fontFamily = RethinkSans,
                                    fontSize = 13.sp,
                                    color = SeekerClawColors.Warning,
                                    lineHeight = 18.sp,
                                )
                            }
                        }
                    }
                }
            }

            // File path
            InfoSection(label = "FILE") {
                Text(
                    text = skill.filePath,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim,
                    lineHeight = 18.sp,
                )
            }
        }
    }
}

@Composable
private fun InfoSection(
    label: String,
    content: @Composable () -> Unit,
) {
    CardSurface {
        InCardLabel(text = label)
        Spacer(Modifier.height(Spacing.sm))
        content()
    }
}
