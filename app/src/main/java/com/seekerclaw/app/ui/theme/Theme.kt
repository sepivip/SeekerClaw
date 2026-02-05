package com.seekerclaw.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// ============================================================================
// THEME SYSTEM — Multiple swappable themes for SeekerClaw
// ============================================================================

/**
 * Available themes
 */
enum class SeekerClawThemeStyle(val displayName: String) {
    DARKOPS("DarkOps"),     // Cyberpunk dark navy + crimson red
    TERMINAL("Terminal"),   // CRT phosphor green terminal
    PIXEL("Pixel"),         // 8-bit arcade with dot matrix
    CLEAN("Clean"),         // Original minimal dark theme
}

/**
 * Color palette interface — all themes provide these colors
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

    // Text
    val textPrimary: Color,
    val textSecondary: Color,
    val textDim: Color,

    // Special effects
    val scanline: Color,
    val dotMatrix: Color,

    // Shape style
    val cornerRadius: Dp,
    val useDotMatrix: Boolean,
    val useScanlines: Boolean,
)

// ============================================================================
// DARKOPS THEME — Cyberpunk dark navy + crimson red + green status
// ============================================================================
val DarkOpsThemeColors = ThemeColors(
    background = Color(0xFF0D0F14),
    surface = Color(0xFF161A25),
    surfaceHighlight = Color(0xFF1E2235),
    cardBorder = Color(0x20FF1744),

    primary = Color(0xFFFF1744),       // Crimson red
    primaryDim = Color(0xFFCC1236),
    primaryGlow = Color(0x33FF1744),

    error = Color(0xFFEF4444),         // Red (distinct from crimson primary)
    errorDim = Color(0xFFCC3636),
    errorGlow = Color(0x33EF4444),

    warning = Color(0xFFFFB300),
    accent = Color(0xFF00E676),        // Electric green (status/online)

    textPrimary = Color(0xDEFFFFFF),   // White 87%
    textSecondary = Color(0x80FFFFFF), // White 50%
    textDim = Color(0x40FFFFFF),       // White 25%

    scanline = Color(0x00000000),
    dotMatrix = Color(0x00000000),

    cornerRadius = 12.dp,
    useDotMatrix = false,
    useScanlines = false,
)

// ============================================================================
// TERMINAL THEME — CRT phosphor green
// ============================================================================
val TerminalThemeColors = ThemeColors(
    background = Color(0xFF050808),
    surface = Color(0xFF0A1210),
    surfaceHighlight = Color(0xFF0F1A16),
    cardBorder = Color(0xFF00FF4125),

    primary = Color(0xFF00FF41),
    primaryDim = Color(0xFF00AA2A),
    primaryGlow = Color(0x3300FF41),

    error = Color(0xFFFF003C),
    errorDim = Color(0xFFAA0028),
    errorGlow = Color(0x33FF003C),

    warning = Color(0xFFFFB000),
    accent = Color(0xFFFF2D2D),

    textPrimary = Color(0xFF00FF41),
    textSecondary = Color(0xFF00AA2A),
    textDim = Color(0xFF006618),

    scanline = Color(0x0800FF41),
    dotMatrix = Color(0x0800FF41),

    cornerRadius = 2.dp,
    useDotMatrix = false,
    useScanlines = false,
)

// ============================================================================
// PIXEL THEME — 8-bit arcade with dot matrix background
// ============================================================================
val PixelThemeColors = ThemeColors(
    background = Color(0xFF0A0A0A),
    surface = Color(0xFF141414),
    surfaceHighlight = Color(0xFF1E1E1E),
    cardBorder = Color(0xFF00FF4140),

    primary = Color(0xFF00FF41),
    primaryDim = Color(0xFF00CC33),
    primaryGlow = Color(0x4000FF41),

    error = Color(0xFFFF2020),
    errorDim = Color(0xFFCC1818),
    errorGlow = Color(0x40FF2020),

    warning = Color(0xFFFFCC00),
    accent = Color(0xFFFF6B00), // Orange for arcade feel

    textPrimary = Color(0xFF00FF41),
    textSecondary = Color(0xFF00CC33),
    textDim = Color(0xFF007722),

    scanline = Color(0x0500FF41),
    dotMatrix = Color(0x1200FF41),

    cornerRadius = 0.dp, // Perfect pixel squares
    useDotMatrix = true,
    useScanlines = true,
)

// ============================================================================
// CLEAN THEME — Original minimal dark (OpenClaw style)
// ============================================================================
val CleanThemeColors = ThemeColors(
    background = Color(0xFF0D0D0D),
    surface = Color(0xFF1A1A1A),
    surfaceHighlight = Color(0xFF242424),
    cardBorder = Color(0x0FFFFFFF),

    primary = Color(0xFF00C805),
    primaryDim = Color(0xFF00A004),
    primaryGlow = Color(0x3300C805),

    error = Color(0xFFFF4444),
    errorDim = Color(0xFFCC3636),
    errorGlow = Color(0x33FF4444),

    warning = Color(0xFFFBBF24),
    accent = Color(0xFFA78BFA), // Purple — OpenClaw brand

    textPrimary = Color(0xDEFFFFFF), // White at 87%
    textSecondary = Color(0x80FFFFFF), // White at 50%
    textDim = Color(0x40FFFFFF), // White at 25%

    scanline = Color(0x00000000),
    dotMatrix = Color(0x00000000),

    cornerRadius = 8.dp,
    useDotMatrix = false,
    useScanlines = false,
)

// ============================================================================
// ACTIVE THEME — Observable state for theme switching
// ============================================================================
object ThemeManager {
    var currentStyle by mutableStateOf(SeekerClawThemeStyle.DARKOPS)
        private set

    fun setTheme(style: SeekerClawThemeStyle) {
        currentStyle = style
    }

    fun getColors(): ThemeColors = when (currentStyle) {
        SeekerClawThemeStyle.DARKOPS -> DarkOpsThemeColors
        SeekerClawThemeStyle.TERMINAL -> TerminalThemeColors
        SeekerClawThemeStyle.PIXEL -> PixelThemeColors
        SeekerClawThemeStyle.CLEAN -> CleanThemeColors
    }
}

// ============================================================================
// BACKWARDS COMPATIBLE — SeekerClawColors delegates to active theme
// ============================================================================
object SeekerClawColors {
    val Background: Color get() = ThemeManager.getColors().background
    val Surface: Color get() = ThemeManager.getColors().surface
    val SurfaceHighlight: Color get() = ThemeManager.getColors().surfaceHighlight
    val CardBorder: Color get() = ThemeManager.getColors().cardBorder

    val Primary: Color get() = ThemeManager.getColors().primary
    val PrimaryDim: Color get() = ThemeManager.getColors().primaryDim
    val PrimaryGlow: Color get() = ThemeManager.getColors().primaryGlow

    val Error: Color get() = ThemeManager.getColors().error
    val ErrorDim: Color get() = ThemeManager.getColors().errorDim
    val ErrorGlow: Color get() = ThemeManager.getColors().errorGlow

    val Warning: Color get() = ThemeManager.getColors().warning
    val Accent: Color get() = ThemeManager.getColors().accent

    val TextPrimary: Color get() = ThemeManager.getColors().textPrimary
    val TextSecondary: Color get() = ThemeManager.getColors().textSecondary
    val TextDim: Color get() = ThemeManager.getColors().textDim

    val Scanline: Color get() = ThemeManager.getColors().scanline
    val DotMatrix: Color get() = ThemeManager.getColors().dotMatrix

    val CornerRadius: Dp get() = ThemeManager.getColors().cornerRadius
    val UseDotMatrix: Boolean get() = ThemeManager.getColors().useDotMatrix
    val UseScanlines: Boolean get() = ThemeManager.getColors().useScanlines
}

// ============================================================================
// MATERIAL THEME INTEGRATION
// ============================================================================
private fun createDarkColorScheme(colors: ThemeColors) = darkColorScheme(
    primary = colors.primary,
    onPrimary = Color.Black,
    secondary = colors.accent,
    onSecondary = Color.Black,
    background = colors.background,
    onBackground = colors.textPrimary,
    surface = colors.surface,
    onSurface = colors.textPrimary,
    surfaceVariant = colors.surfaceHighlight,
    onSurfaceVariant = colors.textSecondary,
    error = colors.error,
    onError = Color.Black,
)

private fun createTypography(colors: ThemeColors) = Typography(
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
        color = colors.textPrimary,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        color = colors.textSecondary,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Bold,
        fontSize = 22.sp,
        lineHeight = 28.sp,
        letterSpacing = 2.sp,
    ),
    labelLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Medium,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        letterSpacing = 1.sp,
    ),
)

val LocalSeekerClawColors = staticCompositionLocalOf { SeekerClawColors }

@Composable
fun SeekerClawTheme(content: @Composable () -> Unit) {
    val colors = ThemeManager.getColors()
    CompositionLocalProvider(LocalSeekerClawColors provides SeekerClawColors) {
        MaterialTheme(
            colorScheme = createDarkColorScheme(colors),
            typography = createTypography(colors),
            content = content,
        )
    }
}
