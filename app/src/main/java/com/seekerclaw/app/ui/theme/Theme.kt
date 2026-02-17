package com.seekerclaw.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ============================================================================
// DARKOPS THEME — SeekerClaw's single theme
// ============================================================================

/**
 * Color palette for the DarkOps theme
 */
data class ThemeColors(
    // Backgrounds
    val background: Color,
    val surface: Color,
    val surfaceHighlight: Color,
    val cardBorder: Color,

    // Primary (main action color)
    val primary: Color,
    val primaryDim: Color,
    val primaryGlow: Color,

    // Error/Danger
    val error: Color,
    val errorDim: Color,
    val errorGlow: Color,

    // Warning
    val warning: Color,

    // Accent (secondary highlight)
    val accent: Color,

    // Semantic actions
    val actionPrimary: Color,      // Green — positive actions (Deploy, Initialize, Connect)
    val actionDanger: Color,       // Dark red bg — destructive actions (Reset, Wipe)
    val actionDangerText: Color,   // Lighter red — danger button text

    // Log info (blue for info-level logs)
    val logInfo: Color,

    // Text
    val textPrimary: Color,
    val textSecondary: Color,
    val textDim: Color,
    val textInteractive: Color,    // 70% white — "Edit"/"Change" labels

    // Special effects
    val scanline: Color,
    val dotMatrix: Color,

    // Borders (opaque variant for switch tracks, button borders)
    val borderSubtle: Color,

    // Shape style
    val cornerRadius: Dp,
    val useDotMatrix: Boolean,
    val useScanlines: Boolean,
)

val DarkOpsThemeColors = ThemeColors(
    background = Color(0xFF0A0A0F),
    surface = Color(0xFF16161F),
    surfaceHighlight = Color(0xFF1E1E2E),
    cardBorder = Color(0x40374151),

    primary = Color(0xFFE41F28),       // SeekerClaw red
    primaryDim = Color(0xFFB81820),
    primaryGlow = Color(0x33E41F28),

    error = Color(0xFFF87171),         // Tailwind red-400
    errorDim = Color(0xFFCC3636),
    errorGlow = Color(0x33F87171),

    warning = Color(0xFFFBBF24),       // Tailwind yellow-400
    accent = Color(0xFF4ADE80),        // Tailwind green-400 (status/online)

    actionPrimary = Color(0xFF00C805), // Green — Deploy, Initialize, Connect
    actionDanger = Color(0xFF8B0000),  // Dark red bg — Reset, Wipe
    actionDangerText = Color(0xFFFF6B6B), // Lighter red text for danger buttons

    logInfo = Color(0xFF60A5FA),       // Tailwind blue-400

    textPrimary = Color(0xF0FFFFFF),   // White ~94%
    textSecondary = Color(0xFF9CA3AF), // Tailwind gray-400
    textDim = Color(0xFF9CA3AF),       // Tailwind gray-400 for dim text
    textInteractive = Color(0xB3FFFFFF), // 70% white — Edit labels

    borderSubtle = Color(0xFF374151), // Tailwind gray-700 — switch tracks, button borders

    scanline = Color(0x00000000),
    dotMatrix = Color(0x00000000),

    cornerRadius = 12.dp,
    useDotMatrix = false,
    useScanlines = false,
)

// ============================================================================
// SeekerClawColors — Global color accessor (DarkOps only)
// ============================================================================
object SeekerClawColors {
    val Background: Color get() = DarkOpsThemeColors.background
    val Surface: Color get() = DarkOpsThemeColors.surface
    val SurfaceHighlight: Color get() = DarkOpsThemeColors.surfaceHighlight
    val CardBorder: Color get() = DarkOpsThemeColors.cardBorder

    val Primary: Color get() = DarkOpsThemeColors.primary
    val PrimaryDim: Color get() = DarkOpsThemeColors.primaryDim
    val PrimaryGlow: Color get() = DarkOpsThemeColors.primaryGlow

    val Error: Color get() = DarkOpsThemeColors.error
    val ErrorDim: Color get() = DarkOpsThemeColors.errorDim
    val ErrorGlow: Color get() = DarkOpsThemeColors.errorGlow

    val Warning: Color get() = DarkOpsThemeColors.warning
    val Accent: Color get() = DarkOpsThemeColors.accent

    val ActionPrimary: Color get() = DarkOpsThemeColors.actionPrimary
    val ActionDanger: Color get() = DarkOpsThemeColors.actionDanger
    val ActionDangerText: Color get() = DarkOpsThemeColors.actionDangerText

    val LogInfo: Color get() = DarkOpsThemeColors.logInfo

    val TextPrimary: Color get() = DarkOpsThemeColors.textPrimary
    val TextSecondary: Color get() = DarkOpsThemeColors.textSecondary
    val TextDim: Color get() = DarkOpsThemeColors.textDim
    val TextInteractive: Color get() = DarkOpsThemeColors.textInteractive

    val BorderSubtle: Color get() = DarkOpsThemeColors.borderSubtle

    val Scanline: Color get() = DarkOpsThemeColors.scanline
    val DotMatrix: Color get() = DarkOpsThemeColors.dotMatrix

    val CornerRadius: Dp get() = DarkOpsThemeColors.cornerRadius
    val UseDotMatrix: Boolean get() = DarkOpsThemeColors.useDotMatrix
    val UseScanlines: Boolean get() = DarkOpsThemeColors.useScanlines
}

// ============================================================================
// MATERIAL THEME INTEGRATION
// ============================================================================
private val DarkColorScheme = darkColorScheme(
    primary = DarkOpsThemeColors.primary,
    onPrimary = Color.Black,
    secondary = DarkOpsThemeColors.accent,
    onSecondary = Color.Black,
    background = DarkOpsThemeColors.background,
    onBackground = DarkOpsThemeColors.textPrimary,
    surface = DarkOpsThemeColors.surface,
    onSurface = DarkOpsThemeColors.textPrimary,
    surfaceVariant = DarkOpsThemeColors.surfaceHighlight,
    onSurfaceVariant = DarkOpsThemeColors.textSecondary,
    error = DarkOpsThemeColors.error,
    onError = Color.Black,
)

private val AppTypography = Typography(
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
        color = DarkOpsThemeColors.textPrimary,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        color = DarkOpsThemeColors.textSecondary,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = 0.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Default,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 0.5.sp,
    ),
)

@Composable
fun SeekerClawTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = AppTypography,
        content = content,
    )
}
