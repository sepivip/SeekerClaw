package com.seekerclaw.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// SeekerClaw 8-bit retrofuturistic palette — Red/Black/Green CRT terminal
object SeekerClawColors {
    // Backgrounds — deep black with the faintest green phosphor tint
    val Background = Color(0xFF050808)
    val Surface = Color(0xFF0A1210)
    val SurfaceHighlight = Color(0xFF0F1A16)
    val CardBorder = Color(0xFF00FF4125)

    // Primary — phosphor green (terminal / matrix)
    val Primary = Color(0xFF00FF41)
    val PrimaryDim = Color(0xFF00AA2A)
    val PrimaryGlow = Color(0x3300FF41)

    // Danger / accent — CRT hot red
    val Error = Color(0xFFFF003C)
    val ErrorDim = Color(0xFFAA0028)
    val ErrorGlow = Color(0x33FF003C)

    // Warning — amber CRT
    val Warning = Color(0xFFFFB000)

    // Accent — kept as a secondary highlight, neon red-orange
    val Accent = Color(0xFFFF2D2D)

    // Text — phosphor green shades
    val TextPrimary = Color(0xFF00FF41)
    val TextSecondary = Color(0xFF00AA2A)
    val TextDim = Color(0xFF006618)

    // Scanline overlay color
    val Scanline = Color(0x0800FF41)
}

private val DarkColorScheme = darkColorScheme(
    primary = SeekerClawColors.Primary,
    onPrimary = Color.Black,
    secondary = SeekerClawColors.Accent,
    onSecondary = Color.Black,
    background = SeekerClawColors.Background,
    onBackground = SeekerClawColors.TextPrimary,
    surface = SeekerClawColors.Surface,
    onSurface = SeekerClawColors.TextPrimary,
    surfaceVariant = SeekerClawColors.SurfaceHighlight,
    onSurfaceVariant = SeekerClawColors.TextSecondary,
    error = SeekerClawColors.Error,
    onError = Color.Black,
)

// Monospace terminal typography throughout — 8-bit feel
private val SeekerClawTypography = Typography(
    bodyLarge = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 15.sp,
        lineHeight = 22.sp,
        color = SeekerClawColors.TextPrimary,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontWeight = FontWeight.Normal,
        fontSize = 13.sp,
        lineHeight = 18.sp,
        color = SeekerClawColors.TextSecondary,
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
    CompositionLocalProvider(LocalSeekerClawColors provides SeekerClawColors) {
        MaterialTheme(
            colorScheme = DarkColorScheme,
            typography = SeekerClawTypography,
            content = content,
        )
    }
}
