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
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.BasicTextField
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
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
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
 * Primary action button — green filled, 56dp, corner glow, RethinkSans bold.
 * Use for: Get Started, Next, Create Agent, Initialize, Connect, Sign In, etc.
 * This is the single source of truth for the app's "do the main thing" button.
 *
 * **Sizing:** Caller is responsible for width. Pass `Modifier.fillMaxWidth()`
 * for a full-width button, or `Modifier.weight(1f)` inside a Row to split
 * space evenly with a sibling button. Height is always [Sizing.buttonPrimaryHeight].
 */
@Composable
fun PrimaryButton(
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    loadingLabel: String = "Working\u2026",
    leadingIcon: (@Composable () -> Unit)? = null,
    height: androidx.compose.ui.unit.Dp = Sizing.buttonPrimaryHeight,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Button(
        onClick = onClick,
        enabled = enabled && !isLoading,
        modifier = modifier
            .height(height)
            .cornerGlowBorder(),
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = SeekerClawColors.ActionPrimary,
            contentColor = Color.White,
            disabledContainerColor = SeekerClawColors.ActionPrimary.copy(alpha = BrandAlpha.disabledSurface),
            disabledContentColor = Color.White.copy(alpha = BrandAlpha.disabledContent),
        ),
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(Sizing.iconSm),
                color = Color.White,
                strokeWidth = 2.dp,
            )
            Spacer(modifier = Modifier.width(Spacing.sm))
            Text(loadingLabel, fontFamily = RethinkSans, fontSize = TypeScale.titleMedium, fontWeight = FontWeight.Bold)
        } else {
            if (leadingIcon != null) {
                leadingIcon()
                Spacer(modifier = Modifier.width(Spacing.sm))
            }
            Text(label, fontFamily = RethinkSans, fontSize = TypeScale.titleMedium, fontWeight = FontWeight.Bold)
        }
    }
}

/**
 * Secondary action button — bordered dark variant. Same shape/glow as
 * PrimaryButton but uses the Surface background + CardBorder stroke, suitable
 * for Back, Cancel, Scan Config, Skip, and other non-primary actions.
 *
 * **Sizing:** Caller supplies width via [modifier] (fillMaxWidth or weight(1f)).
 * Height is always [Sizing.buttonSecondaryHeight].
 */
@Composable
fun SecondaryButton(
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false,
    leadingIcon: (@Composable () -> Unit)? = null,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Button(
        onClick = onClick,
        enabled = enabled && !isLoading,
        modifier = modifier
            .height(Sizing.buttonSecondaryHeight)
            .cornerGlowBorder(),
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = SeekerClawColors.Surface,
            contentColor = SeekerClawColors.TextPrimary,
            disabledContainerColor = SeekerClawColors.Surface,
            disabledContentColor = SeekerClawColors.TextDim,
        ),
        border = BorderStroke(Sizing.borderThin, SeekerClawColors.CardBorder),
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(Sizing.iconSm),
                color = SeekerClawColors.TextPrimary,
                strokeWidth = 2.dp,
            )
        } else {
            if (leadingIcon != null) {
                leadingIcon()
                Spacer(modifier = Modifier.width(Spacing.sm))
            }
            Text(label, fontFamily = RethinkSans, fontSize = TypeScale.bodyMedium, fontWeight = FontWeight.Medium)
        }
    }
}

/**
 * Warning / attention action button — amber tinted variant. Use for "needs
 * attention, not an error" states: Continue Setup, Finish Configuration,
 * Grant Permission, Battery Optimization, etc. Not destructive, not primary
 * — the third semantic color in our action palette.
 */
@Composable
fun WarningButton(
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    leadingIcon: (@Composable () -> Unit)? = null,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .height(Sizing.buttonPrimaryHeight)
            .cornerGlowBorder(),
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = SeekerClawColors.Warning.copy(alpha = BrandAlpha.errorBackground + 0.05f),
            contentColor = SeekerClawColors.Warning,
            disabledContainerColor = SeekerClawColors.Warning.copy(alpha = BrandAlpha.errorBackground),
            disabledContentColor = SeekerClawColors.Warning.copy(alpha = BrandAlpha.disabledContent),
        ),
        border = BorderStroke(
            Sizing.borderThin,
            SeekerClawColors.Warning.copy(alpha = BrandAlpha.disabledSurface),
        ),
    ) {
        if (leadingIcon != null) {
            leadingIcon()
            Spacer(modifier = Modifier.width(Spacing.sm))
        }
        Text(label, fontFamily = RethinkSans, fontSize = TypeScale.titleMedium, fontWeight = FontWeight.Bold)
    }
}

/**
 * State for [DashboardActionButton] — drives the dual-state Deploy / Stop
 * pattern used on the Dashboard. Each state has its own container color,
 * content color, and label so a single button can cycle through the agent
 * lifecycle without the caller re-creating the composable.
 */
enum class DashboardActionState {
    /** Agent is stopped. Button shows "Deploy Agent" in green. */
    Stopped,
    /** Agent is running. Button shows "Stop Agent" in red. */
    Running,
    /** Transition in progress. Button shows spinner, disabled. */
    Transitioning,
}

/**
 * Dashboard Deploy / Stop button. Same shape + glow as the rest of the
 * primary family but toggles color + label based on [state]. Consolidates
 * the two-color primary action pattern on the Dashboard.
 */
@Composable
fun DashboardActionButton(
    state: DashboardActionState,
    onDeploy: () -> Unit,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    deployLabel: String = "Deploy Agent",
    stopLabel: String = "Stop Agent",
    transitioningLabel: String = "Working\u2026",
    leadingIcon: (@Composable (DashboardActionState) -> Unit)? = null,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val container = when (state) {
        DashboardActionState.Stopped -> SeekerClawColors.ActionPrimary
        DashboardActionState.Running -> SeekerClawColors.Primary
        DashboardActionState.Transitioning -> SeekerClawColors.ActionPrimary.copy(alpha = BrandAlpha.disabledSurface)
    }
    Button(
        onClick = {
            when (state) {
                DashboardActionState.Stopped -> onDeploy()
                DashboardActionState.Running -> onStop()
                DashboardActionState.Transitioning -> Unit
            }
        },
        enabled = enabled && state != DashboardActionState.Transitioning,
        modifier = modifier
            .height(Sizing.buttonSecondaryHeight)
            .cornerGlowBorder(),
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = container,
            contentColor = Color.White,
            disabledContainerColor = SeekerClawColors.BorderSubtle,
            disabledContentColor = SeekerClawColors.TextDim,
        ),
    ) {
        if (state == DashboardActionState.Transitioning) {
            CircularProgressIndicator(
                modifier = Modifier.size(Sizing.iconSm),
                color = Color.White,
                strokeWidth = 2.dp,
            )
            Spacer(modifier = Modifier.width(Spacing.sm))
            Text(transitioningLabel, fontFamily = RethinkSans, fontSize = TypeScale.bodyLarge, fontWeight = FontWeight.Bold)
        } else {
            leadingIcon?.invoke(state)
            if (leadingIcon != null) Spacer(modifier = Modifier.width(Spacing.sm))
            Text(
                text = when (state) {
                    DashboardActionState.Stopped -> deployLabel
                    DashboardActionState.Running -> stopLabel
                    DashboardActionState.Transitioning -> transitioningLabel
                },
                fontFamily = RethinkSans,
                fontSize = TypeScale.bodyLarge,
                fontWeight = FontWeight.Bold,
            )
        }
    }
}

/**
 * Danger / destructive primary button — same shape, height, and corner glow as
 * the green primary action button, but in the brand danger red. Use for Sign Out,
 * Reset Config, Wipe Memory, Delete Account, etc. Centralizes the visual so every
 * destructive action across the app shares one look.
 */
@Composable
fun DangerButton(
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .fillMaxWidth()
            .height(Sizing.buttonPrimaryHeight)
            .cornerGlowBorder(),
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = SeekerClawColors.ActionDanger,
            contentColor = Color.White,
            disabledContainerColor = SeekerClawColors.ActionDanger.copy(alpha = BrandAlpha.disabledSurface),
            disabledContentColor = Color.White.copy(alpha = BrandAlpha.disabledContent),
        ),
    ) {
        Text(
            label,
            fontFamily = RethinkSans,
            fontSize = TypeScale.titleMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}

/**
 * Softer destructive button — M3 outlined variant. Red border, transparent fill,
 * red text. Use for reversible destructive actions like Sign Out, Cancel, Remove
 * where full-red [DangerButton] would feel too aggressive. Same height, shape,
 * and glow as every other primary button so it sits in the app rhythm.
 */
@Composable
fun DangerOutlineButton(
    onClick: () -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier
            .fillMaxWidth()
            .height(Sizing.buttonPrimaryHeight)
            .cornerGlowBorder(),
        shape = shape,
        colors = ButtonDefaults.buttonColors(
            containerColor = Color.Transparent,
            contentColor = SeekerClawColors.Error,
            disabledContainerColor = Color.Transparent,
            disabledContentColor = SeekerClawColors.Error.copy(alpha = BrandAlpha.disabledContent),
        ),
        border = BorderStroke(Sizing.borderThin, SeekerClawColors.Error.copy(alpha = BrandAlpha.disabledSurface)),
    ) {
        Text(
            label,
            fontFamily = RethinkSans,
            fontSize = TypeScale.titleMedium,
            fontWeight = FontWeight.Bold,
        )
    }
}

/**
 * Reusable corner-glow border modifier — replicates atomicbot.ai's `.gradient-border`
 * effect. Two radial gradients (top-left + bottom-right) painted as stroked rounded
 * rects so only the border ring receives the highlight, brightest at the corner,
 * fading to transparent at ~45% of the element's min dimension.
 *
 * Apply this to ANY surface (card, button, container) that needs the SeekerClaw
 * "lit-edge" treatment. Single token (BrandAlpha.cardHighlight) controls intensity.
 *
 * Usage:
 *   Box(Modifier.background(...).cornerGlowBorder(corner = 16.dp))
 *   Button(modifier = Modifier.cornerGlowBorder(corner = 12.dp), ...)
 */
fun Modifier.cornerGlowBorder(corner: androidx.compose.ui.unit.Dp = SeekerClawColors.CornerRadius): Modifier =
    this.drawBehind {
        val cornerPx = corner.toPx()
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

    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Surface, cardShape)
            .cornerGlowBorder()
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
        // Use Background (darker than Surface) so the button stands out from the
        // CardSurface it usually sits inside.
        else -> SeekerClawColors.Background
    }
    val content = when (state) {
        is ActionResult.Success -> SeekerClawColors.Accent
        is ActionResult.Error -> SeekerClawColors.Error
        else -> SeekerClawColors.TextPrimary
    }
    val borderColor = when (state) {
        is ActionResult.Success -> SeekerClawColors.Accent.copy(alpha = BrandAlpha.disabledSurface)
        is ActionResult.Error -> SeekerClawColors.Error.copy(alpha = BrandAlpha.disabledSurface)
        // Brighter idle border so the button has a clear edge against the card
        else -> SeekerClawColors.TextDim.copy(alpha = BrandAlpha.disabledSurface)
    }

    Button(
        onClick = onClick,
        enabled = enabled && state !is ActionResult.Loading,
        modifier = modifier
            .fillMaxWidth()
            .height(Sizing.buttonSecondaryHeight)
            .cornerGlowBorder(),
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

/**
 * Visual transformation that mirrors Settings' [maskKey] display:
 * shows the first 6 characters, 8 asterisks, and the last 4 characters
 * (e.g. "sk-ant-********abc1"). Strings <=10 chars are fully masked.
 *
 * Cursor positions inside the masked middle clamp to the start of the
 * star segment — fine for read-mostly fields where users paste new
 * keys whole rather than editing characters.
 */
private class MaskMiddleTransformation : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val raw = text.text
        if (raw.length <= 10) {
            return TransformedText(
                AnnotatedString("*".repeat(raw.length)),
                OffsetMapping.Identity,
            )
        }
        val masked = buildString {
            append(raw.take(6))
            append("*".repeat(8))
            append(raw.takeLast(4))
        }
        return TransformedText(
            text = AnnotatedString(masked),
            offsetMapping = object : OffsetMapping {
                override fun originalToTransformed(offset: Int): Int {
                    return when {
                        offset <= 6 -> offset
                        offset >= raw.length - 4 -> 14 + (offset - (raw.length - 4))
                        else -> 14
                    }.coerceIn(0, masked.length)
                }
                override fun transformedToOriginal(offset: Int): Int {
                    return when {
                        offset <= 6 -> offset
                        offset >= 14 -> raw.length - 4 + (offset - 14)
                        else -> 6
                    }.coerceIn(0, raw.length)
                }
            },
        )
    }
}

/** Convenience visual transformations exposed to callers. */
object InputMask {
    /** Show first 6 + 8 stars + last 4. Mirrors Settings' maskKey display. */
    val MaskMiddle: VisualTransformation = MaskMiddleTransformation()

    /** Standard password mask — every char becomes a bullet. */
    val Password: VisualTransformation = PasswordVisualTransformation()
}

/**
 * Compound input + inline action button (shadcn-style "input with addon").
 *
 * Single rounded surface, single border, input on the left, action zone on the
 * right separated by a vertical divider. The action zone **morphs by context**:
 * - Empty field + [pasteEnabled]=true → "Paste" (reads clipboard, fills field)
 * - Filled field, Idle                → primary [actionLabel] (e.g. "Test")
 * - Loading / Success / Error         → spinner / ✓ / ✕ from [actionState]
 *
 * This means only one trailing button is ever visible at a time: paste when
 * the user can't do anything else, test when the field is ready to validate.
 * Reuses [ActionResult] for post-action state.
 *
 * Use for any secret field that needs both a paste shortcut and an inline
 * test/verify action — API keys, bot tokens, webhooks, etc.
 */
@Composable
fun InputWithActionButton(
    value: String,
    onValueChange: (String) -> Unit,
    actionLabel: String,
    onAction: () -> Unit,
    actionState: ActionResult,
    modifier: Modifier = Modifier,
    placeholder: String = "",
    visualTransformation: VisualTransformation = VisualTransformation.None,
    enabled: Boolean = true,
    isError: Boolean = false,
    pasteEnabled: Boolean = true,
    pasteLabel: String = "Paste",
) {
    val clipboard = LocalClipboardManager.current
    val showPaste = pasteEnabled && value.isEmpty() && actionState is ActionResult.Idle
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)

    val borderColor = when {
        isError -> SeekerClawColors.Error
        actionState is ActionResult.Success -> SeekerClawColors.Accent.copy(alpha = BrandAlpha.disabledSurface)
        actionState is ActionResult.Error -> SeekerClawColors.Error.copy(alpha = BrandAlpha.disabledSurface)
        else -> SeekerClawColors.CardBorder
    }

    val actionContainer = when (actionState) {
        is ActionResult.Success -> SeekerClawColors.Accent.copy(alpha = BrandAlpha.errorBackground + 0.02f)
        is ActionResult.Error -> SeekerClawColors.Error.copy(alpha = BrandAlpha.errorBackground + 0.02f)
        else -> SeekerClawColors.Background
    }
    val actionContent = when (actionState) {
        is ActionResult.Success -> SeekerClawColors.Accent
        is ActionResult.Error -> SeekerClawColors.Error
        else -> SeekerClawColors.TextPrimary
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(Sizing.buttonPrimaryHeight)
            .clip(shape)
            .background(SeekerClawColors.Surface, shape)
            .border(BorderStroke(Sizing.borderThin, borderColor), shape)
            .cornerGlowBorder(),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Input zone
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .padding(horizontal = Spacing.lg),
            contentAlignment = Alignment.CenterStart,
        ) {
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                singleLine = true,
                enabled = enabled,
                visualTransformation = visualTransformation,
                textStyle = TextStyle(
                    color = SeekerClawColors.TextPrimary,
                    fontSize = TypeScale.bodyMedium.value.sp,
                    fontFamily = FontFamily.Monospace,
                ),
                cursorBrush = SolidColor(SeekerClawColors.Primary),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { innerTextField ->
                    if (value.isEmpty() && placeholder.isNotEmpty()) {
                        Text(
                            text = placeholder,
                            color = SeekerClawColors.TextDim,
                            fontSize = TypeScale.bodyMedium,
                            fontFamily = FontFamily.Monospace,
                        )
                    }
                    innerTextField()
                },
            )
        }

        // Vertical divider
        Box(
            modifier = Modifier
                .width(Sizing.borderThin)
                .fillMaxHeight()
                .background(SeekerClawColors.CardBorder),
        )

        // Action zone — morphs with state
        val actionEnabled = enabled && actionState !is ActionResult.Loading
        val onZoneClick: () -> Unit = {
            if (showPaste) {
                val pasted = clipboard.getText()?.text?.trim().orEmpty()
                if (pasted.isNotEmpty()) onValueChange(pasted)
            } else {
                onAction()
            }
        }
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .background(actionContainer)
                .clickable(enabled = actionEnabled) { onZoneClick() }
                .padding(horizontal = Spacing.lg),
            contentAlignment = Alignment.Center,
        ) {
            when {
                showPaste -> Text(
                    pasteLabel,
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = actionContent,
                )
                actionState is ActionResult.Loading -> androidx.compose.material3.CircularProgressIndicator(
                    modifier = Modifier.size(Sizing.iconSm),
                    color = actionContent,
                    strokeWidth = 2.dp,
                )
                actionState is ActionResult.Success -> Text(
                    "\u2713",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = actionContent,
                )
                actionState is ActionResult.Error -> Text(
                    "\u2715",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = actionContent,
                )
                else -> Text(
                    actionLabel,
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.bodyMedium,
                    fontWeight = FontWeight.Bold,
                    color = actionContent,
                )
            }
        }
    }
}
