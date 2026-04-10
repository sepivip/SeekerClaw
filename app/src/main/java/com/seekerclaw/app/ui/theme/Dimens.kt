package com.seekerclaw.app.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * SeekerClaw design tokens — Material 3 compliant 8dp grid.
 *
 * Never hardcode dp/sp values in screens. Always reference these tokens.
 * If a value you need isn't here, add it — don't inline it.
 *
 * Scale follows Google's M3 spacing scale: 4, 8, 12, 16, 24, 32, 40, 48, 56, 64
 */
object Spacing {
    val xxs = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 24.dp
    val xxl = 32.dp
    val xxxl = 48.dp
    val huge = 64.dp
    val heroTop = 72.dp
}

/**
 * Component sizing tokens. Heights, icon sizes, hero elements.
 */
object Sizing {
    // Buttons — M3 height standards
    val buttonPrimaryHeight = 56.dp
    val buttonSecondaryHeight = 52.dp

    // Icons
    val iconSm = 16.dp
    val iconMd = 18.dp
    val iconLg = 20.dp

    // Borders / strokes
    val borderThin = 1.dp
    val strokeMedium = 1.5f

    // Setup hero
    val heroBoxSize = 216.dp
    val heroLogoSize = 166.dp
    val heroShadowOffsetY = 18.dp
    val heroShadowRadius = 120.dp

    // Page-dot indicator
    val pageDotSize = 8.dp
    val pageDotActiveWidth = 24.dp
    val pageDotCornerRadius = 4.dp
}

/**
 * Typography sizing tokens — scaled to the SeekerClaw setup flow.
 */
object TypeScale {
    val displayLarge = 33.sp
    val displaySmall = 29.sp
    val titleLarge = 20.sp
    val titleMedium = 16.sp
    val bodyLarge = 15.sp
    val bodyMedium = 14.sp
    val bodySmall = 13.sp
    val labelSmall = 12.sp

    val lineHeightDisplayLarge = 38.sp
    val lineHeightDisplaySmall = 34.sp
    val lineHeightBody = 22.sp
}

/**
 * Setup-screen specific layout constants. These are the only "magic numbers"
 * allowed outside the generic scales above — and only because they're named.
 */
object SetupLayout {
    val contentHorizontal = Spacing.xl         // 24
    val contentTop = Spacing.xl                // 24
    val contentBottom = Spacing.xxl            // 32
    val heroTop = Spacing.heroTop              // 72
    val gapAfterIndicator = Spacing.xl         // 24
    val gapBeforeNav = Spacing.lg              // 16
    val gapBetweenButtons = Spacing.md         // 12

    // Welcome background
    val blob1Radius = 312.dp
    val blob2Radius = 288.dp
    val blob1Drift = 180.dp
    val blob2Drift = 220.dp
    val gridSpacing = Spacing.xxl              // 32
}

/**
 * Named alpha tokens. Never inline a 0.xxf alpha value — if a new one is
 * needed, add it here with a descriptive name so future changes flow from
 * one place.
 */
object BrandAlpha {
    // Aurora background blobs
    const val blob1Core = 0.55f
    const val blob1Mid = 0.25f
    const val blob2Core = 0.45f
    const val blob2Mid = 0.18f

    // Grid lines
    const val gridLine = 0.18f

    // Logo ambient shadow
    const val shadowStrong = 0.70f
    const val shadowSoft = 0.35f

    // UI states
    const val disabledSurface = 0.50f
    const val disabledContent = 0.70f
    const val errorBackground = 0.10f

    // Card edge highlights — corner glow border on CardSurface
    // Mirrors atomicbot.ai's gradient-border technique (0.28 alpha)
    const val cardHighlight = 0.28f
}

/**
 * Semantic color roles for the onboarding flow. Keeps raw Color.Black /
 * Color.White out of screens so the palette stays swappable from here.
 */
object OnboardingColors {
    val heroBackground = Color.Black
    val onActionPrimary = Color.White
}

