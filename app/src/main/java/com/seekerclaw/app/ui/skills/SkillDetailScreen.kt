package com.seekerclaw.app.ui.skills

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.res.stringResource
import com.seekerclaw.app.R
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors

@Composable
fun SkillDetailScreen(
    skill: SkillInfo,
    onBack: () -> Unit,
    onExport: (() -> Unit)? = null,
) {
    val shape = remember { RoundedCornerShape(SeekerClawColors.CornerRadius) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SeekerClawColors.Background)
            .verticalScroll(rememberScrollState()),
    ) {
        // Top bar
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(
                text = stringResource(R.string.skill_back),
                fontFamily = RethinkSans,
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.Primary,
                modifier = Modifier.clickable(onClickLabel = stringResource(R.string.skill_cd_back), onClick = onBack),
            )
            if (onExport != null) {
                Text(
                    text = stringResource(R.string.button_export),
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.Medium,
                    color = SeekerClawColors.Accent,
                    modifier = Modifier
                        .clickable(onClickLabel = stringResource(R.string.skill_cd_export), onClick = onExport)
                        .padding(4.dp),
                )
            }
        }

        HorizontalDivider(
            thickness = 1.dp,
            color = SeekerClawColors.CardBorder,
        )

        Column(
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            // Header: avatar + name + version
            Row(verticalAlignment = Alignment.CenterVertically) {
                SkillAvatar(skill = skill, size = 56, emojiFontSize = 32)
                Spacer(Modifier.width(16.dp))
                Column {
                    Text(
                        text = skill.name,
                        fontFamily = RethinkSans,
                        fontSize = 22.sp,
                        fontWeight = FontWeight.Bold,
                        color = SeekerClawColors.TextPrimary,
                    )
                    if (skill.version.isNotEmpty()) {
                        Spacer(Modifier.height(2.dp))
                        Text(
                            text = "v${skill.version.removePrefix("v").removePrefix("V")}",
                            fontFamily = FontFamily.Monospace,
                            fontSize = 12.sp,
                            color = SeekerClawColors.TextDim,
                        )
                    }
                }
            }

            // Type
            InfoSection(label = stringResource(R.string.skill_section_type), shape = shape) {
                Text(
                    text = if (skill.isDefault) stringResource(R.string.skill_type_default) else stringResource(R.string.skill_type_added),
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextPrimary,
                )
            }

            // Description
            if (skill.description.isNotEmpty()) {
                InfoSection(label = stringResource(R.string.skill_section_description), shape = shape) {
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
            InfoSection(label = stringResource(R.string.skill_section_triggers), shape = shape) {
                if (skill.triggers.isEmpty()) {
                    Text(
                        text = stringResource(R.string.skill_trigger_semantic),
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
                InfoSection(label = stringResource(R.string.skill_section_diagnostics), shape = shape) {
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
                                    text = warning,
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
            InfoSection(label = stringResource(R.string.skill_section_file), shape = shape) {
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
    shape: RoundedCornerShape,
    content: @Composable () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, shape)
            .padding(16.dp),
    ) {
        Text(
            text = label,
            fontFamily = RethinkSans,
            fontSize = 11.sp,
            fontWeight = FontWeight.Bold,
            color = SeekerClawColors.TextDim,
            letterSpacing = 1.sp,
        )
        Spacer(Modifier.height(10.dp))
        content()
    }
}
