package com.seekerclaw.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.theme.BrandAlpha
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Sizing
import com.seekerclaw.app.ui.theme.Spacing
import com.seekerclaw.app.ui.theme.TypeScale

/**
 * Standard card surface used throughout SeekerClaw: Surface background, rounded corners, 16dp padding.
 * Replaces the repeated Column + fillMaxWidth + background(Surface, shape) + padding(16.dp) pattern.
 */
@Composable
fun CardSurface(
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val cardShape = remember(SeekerClawColors.CornerRadius) { RoundedCornerShape(SeekerClawColors.CornerRadius) }

    // Corner-glow border — replicates atomicbot.ai's `.gradient-border` effect.
    // Two radial gradients (top-left and bottom-right), each painted as a stroked
    // rounded rect so only the border ring receives the highlight. Brightest at
    // the corner, fading to transparent at ~45% radius.
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, cardShape)
            .drawBehind {
                val cornerPx = SeekerClawColors.CornerRadius.toPx()
                val cr = CornerRadius(cornerPx, cornerPx)
                val strokePx = Sizing.borderThin.toPx()
                val highlightRadius = size.minDimension * 0.45f

                // Top-left highlight
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color.White.copy(alpha = BrandAlpha.cardHighlight),
                            Color.Transparent,
                        ),
                        center = Offset(0f, 0f),
                        radius = highlightRadius,
                    ),
                    cornerRadius = cr,
                    style = Stroke(width = strokePx),
                )
                // Bottom-right highlight
                drawRoundRect(
                    brush = Brush.radialGradient(
                        colors = listOf(
                            Color.White.copy(alpha = BrandAlpha.cardHighlight),
                            Color.Transparent,
                        ),
                        center = Offset(size.width, size.height),
                        radius = highlightRadius,
                    ),
                    cornerRadius = cr,
                    style = Stroke(width = strokePx),
                )
            }
            .padding(16.dp),
        content = content,
    )
}

/**
 * Label/value row with optional status dot and divider.
 * Monospace font for both label and value. Used in SystemScreen, SettingsScreen, etc.
 */
@Composable
fun InfoRow(
    label: String,
    value: String,
    dotColor: Color? = null,
    isLast: Boolean = false,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = SeekerClawColors.TextSecondary,
        )
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = value,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = SeekerClawColors.TextPrimary,
            )
            if (dotColor != null) {
                Spacer(modifier = Modifier.width(8.dp))
                Box(
                    modifier = Modifier
                        .size(10.dp)
                        .clip(CircleShape)
                        .background(dotColor),
                )
            }
        }
    }
    if (!isLast) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(SeekerClawColors.TextDim.copy(alpha = 0.15f)),
        )
    }
}

/**
 * Shared top app bar with back navigation, styled for SeekerClaw's DarkOps theme.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SeekerClawTopAppBar(title: String, onBack: () -> Unit) {
    TopAppBar(
        title = {
            Text(
                text = title,
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
        colors = TopAppBarDefaults.topAppBarColors(
            containerColor = SeekerClawColors.Background,
        ),
    )
}

/**
 * Section label used across settings, setup, and system screens.
 * RethinkSans, ExtraBold, white. Callers are responsible for adding
 * their own bottom spacing.
 */
@Composable
fun SectionLabel(title: String) {
    Text(
        text = title,
        fontFamily = RethinkSans,
        fontSize = 14.sp,
        fontWeight = FontWeight.ExtraBold,
        color = SeekerClawColors.TextPrimary,
    )
}

/**
 * Config field row showing a label/value pair with optional edit action, info button, and divider.
 */
@Composable
fun ConfigField(
    label: String,
    value: String,
    onClick: (() -> Unit)? = null,
    showDivider: Boolean = true,
    info: String? = null,
    isRequired: Boolean = false,
) {
    var showInfo by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = if (isRequired) Modifier.semantics(mergeDescendants = true) {
                    contentDescription = "$label, required"
                } else Modifier,
            ) {
                Text(
                    text = label,
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
                if (isRequired) {
                    Text(
                        text = " *",
                        fontSize = 12.sp,
                        color = SeekerClawColors.Error,
                    )
                }
                if (info != null) {
                    IconButton(
                        onClick = { showInfo = true },
                    ) {
                        Icon(
                            Icons.Outlined.Info,
                            contentDescription = "More info about $label",
                            tint = SeekerClawColors.TextDim,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
            }
            if (onClick != null) {
                Text(
                    text = "Edit",
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextInteractive,
                )
            }
        }
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            fontFamily = RethinkSans,
            fontSize = 14.sp,
            color = SeekerClawColors.TextPrimary,
        )
    }
    if (showDivider) {
        HorizontalDivider(
            color = SeekerClawColors.CardBorder,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
    }

    if (showInfo && info != null) {
        InfoDialog(title = label, message = info, onDismiss = { showInfo = false })
    }
}

/**
 * Standard Scaffold + TopAppBar wrapper for detail screens (System, Provider, Telegram, Search).
 * Provides consistent containerColor and top bar styling.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SeekerClawScaffold(
    title: String,
    onBack: () -> Unit,
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        topBar = { SeekerClawTopAppBar(title = title, onBack = onBack) },
        containerColor = SeekerClawColors.Background,
        content = content,
    )
}

/**
 * Standard Switch with SeekerClaw colors: ActionPrimary (green) when checked,
 * BorderSubtle when unchecked. All toggles throughout the app should use this.
 */
@Composable
fun SeekerClawSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    Switch(
        checked = checked,
        onCheckedChange = onCheckedChange,
        modifier = modifier,
        colors = SwitchDefaults.colors(
            checkedThumbColor = Color.White,
            checkedTrackColor = SeekerClawColors.ActionPrimary,
            uncheckedThumbColor = Color.White,
            uncheckedTrackColor = SeekerClawColors.BorderSubtle,
            uncheckedBorderColor = Color.Transparent,
        ),
    )
}

/**
 * Informational dialog with a title, message, and "Got it" dismiss button.
 */
@Composable
fun InfoDialog(title: String, message: String, onDismiss: () -> Unit) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                text = title,
                fontFamily = RethinkSans,
                fontWeight = FontWeight.Bold,
                fontSize = 16.sp,
                color = SeekerClawColors.TextPrimary,
            )
        },
        text = {
            Text(
                text = message,
                fontFamily = RethinkSans,
                fontSize = 13.sp,
                color = SeekerClawColors.TextSecondary,
                lineHeight = 20.sp,
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(
                    "Got it",
                    fontFamily = RethinkSans,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.Primary,
                )
            }
        },
        containerColor = SeekerClawColors.Surface,
        shape = shape,
    )
}

/**
 * Result state for [MorphActionButton]. Drives the button's container/content/border
 * color and its label, following Material 3's state-driven button pattern.
 *
 * Used by Test Connection, Verify, Validate, Reload, Sync, etc. — any inline action
 * that needs persistent inline feedback after running.
 */
sealed class ActionResult {
    data object Idle : ActionResult()
    data object Loading : ActionResult()
    data class Success(val message: String) : ActionResult()
    data class Error(val message: String) : ActionResult()
}

/**
 * Material 3 inline-morph action button. The button itself reflects the action's
 * result via container/content/border color and a swapped label — no separate text
 * line below. Pattern matches Stripe / GitHub / Vercel "Test webhook" / "Verify"
 * buttons. Reusable across the app for any inline test/verify/sync action.
 *
 * Reset to [ActionResult.Idle] when the underlying input changes so the user
 * can re-run.
 */
@Composable
fun MorphActionButton(
    state: ActionResult,
    idleLabel: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    loadingLabel: String = "Working\u2026",
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    val container = when (state) {
        is ActionResult.Success -> SeekerClawColors.Accent.copy(alpha = BrandAlpha.errorBackground + 0.02f)
        is ActionResult.Error -> SeekerClawColors.Error.copy(alpha = BrandAlpha.errorBackground + 0.02f)
        else -> SeekerClawColors.Surface
    }
    val content = when (state) {
        is ActionResult.Success -> SeekerClawColors.Accent
        is ActionResult.Error -> SeekerClawColors.Error
        else -> SeekerClawColors.TextPrimary
    }
    val borderColor = when (state) {
        is ActionResult.Success -> SeekerClawColors.Accent.copy(alpha = BrandAlpha.disabledSurface)
        is ActionResult.Error -> SeekerClawColors.Error.copy(alpha = BrandAlpha.disabledSurface)
        else -> SeekerClawColors.CardBorder
    }

    Button(
        onClick = onClick,
        enabled = enabled && state !is ActionResult.Loading,
        modifier = modifier
            .fillMaxWidth()
            .height(Sizing.buttonSecondaryHeight),
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = container,
            contentColor = content,
            disabledContainerColor = container,
            disabledContentColor = content,
        ),
        border = BorderStroke(Sizing.borderThin, borderColor),
    ) {
        when (state) {
            is ActionResult.Loading -> {
                CircularProgressIndicator(
                    modifier = Modifier.size(Sizing.iconSm),
                    color = SeekerClawColors.TextPrimary,
                    strokeWidth = 2.dp,
                )
                Spacer(modifier = Modifier.width(Spacing.sm))
                Text(
                    loadingLabel,
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.bodyMedium,
                    fontWeight = FontWeight.Medium,
                )
            }
            is ActionResult.Success -> Text(
                "\u2713 ${state.message}",
                fontFamily = RethinkSans,
                fontSize = TypeScale.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = Spacing.sm),
            )
            is ActionResult.Error -> Text(
                "\u2715 ${state.message}",
                fontFamily = RethinkSans,
                fontSize = TypeScale.bodyMedium,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(horizontal = Spacing.sm),
            )
            ActionResult.Idle -> Text(
                idleLabel,
                fontFamily = RethinkSans,
                fontSize = TypeScale.bodyMedium,
                fontWeight = FontWeight.Medium,
            )
        }
    }
}
