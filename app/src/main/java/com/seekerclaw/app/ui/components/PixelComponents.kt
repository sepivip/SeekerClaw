package com.seekerclaw.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.theme.SeekerClawColors

/**
 * Dot matrix background modifier — creates a halftone CRT pattern
 */
fun Modifier.dotMatrix(
    dotColor: Color = SeekerClawColors.PrimaryDim.copy(alpha = 0.08f),
    dotSpacing: Dp = 8.dp,
    dotRadius: Dp = 1.dp,
): Modifier = this.drawBehind {
    val spacingPx = dotSpacing.toPx()
    val radiusPx = dotRadius.toPx()

    var x = 0f
    while (x < size.width) {
        var y = 0f
        while (y < size.height) {
            drawCircle(
                color = dotColor,
                radius = radiusPx,
                center = Offset(x, y),
            )
            y += spacingPx
        }
        x += spacingPx
    }
}

/**
 * Scanline overlay modifier — horizontal lines for CRT effect
 */
fun Modifier.scanlines(
    lineColor: Color = SeekerClawColors.Scanline,
    lineSpacing: Dp = 3.dp,
): Modifier = this.drawBehind {
    val spacingPx = lineSpacing.toPx()
    var y = 0f
    while (y < size.height) {
        drawLine(
            color = lineColor,
            start = Offset(0f, y),
            end = Offset(size.width, y),
            strokeWidth = 1f,
        )
        y += spacingPx
    }
}

/**
 * Chunky pixel arrow — left pointing ◄
 */
@Composable
fun PixelArrowLeft(
    modifier: Modifier = Modifier,
    color: Color = SeekerClawColors.Primary,
    size: Dp = 24.dp,
    onClick: (() -> Unit)? = null,
) {
    val clickMod = if (onClick != null) Modifier.clickable { onClick() } else Modifier
    Canvas(
        modifier = modifier
            .size(size)
            .then(clickMod)
    ) {
        val w = this.size.width
        val h = this.size.height
        val path = Path().apply {
            // Pixel-style arrow pointing left
            moveTo(w * 0.8f, h * 0.15f)
            lineTo(w * 0.8f, h * 0.35f)
            lineTo(w * 0.5f, h * 0.35f)
            lineTo(w * 0.5f, h * 0.15f)
            lineTo(w * 0.2f, h * 0.5f)
            lineTo(w * 0.5f, h * 0.85f)
            lineTo(w * 0.5f, h * 0.65f)
            lineTo(w * 0.8f, h * 0.65f)
            lineTo(w * 0.8f, h * 0.85f)
            close()
        }
        // Simplified chunky arrow
        drawPath(
            path = Path().apply {
                moveTo(w * 0.75f, h * 0.2f)
                lineTo(w * 0.25f, h * 0.5f)
                lineTo(w * 0.75f, h * 0.8f)
                lineTo(w * 0.75f, h * 0.6f)
                lineTo(w * 0.5f, h * 0.6f)
                lineTo(w * 0.5f, h * 0.4f)
                lineTo(w * 0.75f, h * 0.4f)
                close()
            },
            color = color,
        )
    }
}

/**
 * Chunky pixel arrow — right pointing ►
 */
@Composable
fun PixelArrowRight(
    modifier: Modifier = Modifier,
    color: Color = SeekerClawColors.Primary,
    size: Dp = 24.dp,
    onClick: (() -> Unit)? = null,
) {
    val clickMod = if (onClick != null) Modifier.clickable { onClick() } else Modifier
    Canvas(
        modifier = modifier
            .size(size)
            .then(clickMod)
    ) {
        val w = this.size.width
        val h = this.size.height
        drawPath(
            path = Path().apply {
                moveTo(w * 0.25f, h * 0.2f)
                lineTo(w * 0.25f, h * 0.4f)
                lineTo(w * 0.5f, h * 0.4f)
                lineTo(w * 0.5f, h * 0.6f)
                lineTo(w * 0.25f, h * 0.6f)
                lineTo(w * 0.25f, h * 0.8f)
                lineTo(w * 0.75f, h * 0.5f)
                close()
            },
            color = color,
        )
    }
}

/**
 * Square block step indicator — 8-bit style progress dots
 */
@Composable
fun PixelStepIndicator(
    currentStep: Int,
    totalSteps: Int,
    modifier: Modifier = Modifier,
    activeColor: Color = SeekerClawColors.Primary,
    inactiveColor: Color = SeekerClawColors.PrimaryDim.copy(alpha = 0.3f),
    blockSize: Dp = 12.dp,
    spacing: Dp = 6.dp,
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        for (i in 0 until totalSteps) {
            Box(
                modifier = Modifier
                    .size(blockSize)
                    .background(
                        if (i <= currentStep) activeColor else inactiveColor,
                        RoundedCornerShape(SeekerClawColors.CornerRadius),
                    )
                    .then(
                        if (i == currentStep) {
                            Modifier.border(1.dp, activeColor.copy(alpha = 0.5f))
                        } else {
                            Modifier
                        }
                    )
            )
            if (i < totalSteps - 1) {
                // Connecting line between blocks
                Box(
                    modifier = Modifier
                        .width(spacing)
                        .height(2.dp)
                        .background(
                            if (i < currentStep) activeColor.copy(alpha = 0.5f)
                            else inactiveColor.copy(alpha = 0.5f)
                        )
                )
            }
        }
    }
}

/**
 * ASCII art logo for SeekerClaw
 */
@Composable
fun AsciiLogo(
    modifier: Modifier = Modifier,
    color: Color = SeekerClawColors.Primary,
) {
    val logo = """
     _____ _____ _____ _____ _____ _____
    |   __|   __|   __|  |  |   __| __  |
    |__   |   __|   __|    -|   __|    -|
    |_____|_____|_____|__|__|_____|__|__|
          _____ __    _____ _ _ _
         |     |  |  |  _  | | | |
         |   --|  |__|     | | | |
         |_____|_____|__|__|_____|
    """.trimIndent()

    Text(
        text = logo,
        modifier = modifier,
        fontFamily = FontFamily.Monospace,
        fontSize = 8.sp,
        lineHeight = 9.sp,
        color = color,
        textAlign = TextAlign.Center,
        letterSpacing = 0.sp,
    )
}

/**
 * Compact ASCII logo — single line style
 */
@Composable
fun AsciiLogoCompact(
    modifier: Modifier = Modifier,
    color: Color = SeekerClawColors.Primary,
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = "╔═══════════════════════╗",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = color,
            letterSpacing = 0.sp,
        )
        Text(
            text = "║   S E E K E R C L A W   ║",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = color,
            letterSpacing = 0.sp,
        )
        Text(
            text = "╚═══════════════════════╝",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = color,
            letterSpacing = 0.sp,
        )
    }
}

/**
 * Pixel-style navigation buttons with chunky arrows
 */
@Composable
fun PixelNavButtons(
    onBack: () -> Unit,
    onNext: () -> Unit,
    nextEnabled: Boolean,
    modifier: Modifier = Modifier,
    backLabel: String = "BACK",
    nextLabel: String = "NEXT",
) {
    Row(
        modifier = modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // Back button with arrow
        Row(
            modifier = Modifier
                .clickable { onBack() }
                .padding(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            PixelArrowLeft(
                color = SeekerClawColors.Accent,
                size = 20.dp,
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                text = backLabel,
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = SeekerClawColors.Accent,
                letterSpacing = 1.sp,
            )
        }

        // Next button with arrow
        Row(
            modifier = Modifier
                .then(
                    if (nextEnabled) Modifier.clickable { onNext() }
                    else Modifier
                )
                .background(
                    if (nextEnabled) SeekerClawColors.PrimaryGlow else SeekerClawColors.Surface,
                    RoundedCornerShape(2.dp),
                )
                .border(
                    1.dp,
                    if (nextEnabled) SeekerClawColors.Primary else SeekerClawColors.TextDim,
                    RoundedCornerShape(2.dp),
                )
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = nextLabel,
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
                fontWeight = FontWeight.Bold,
                color = if (nextEnabled) SeekerClawColors.Primary else SeekerClawColors.TextDim,
                letterSpacing = 1.sp,
            )
            Spacer(modifier = Modifier.width(4.dp))
            PixelArrowRight(
                color = if (nextEnabled) SeekerClawColors.Primary else SeekerClawColors.TextDim,
                size = 20.dp,
            )
        }
    }
}

/**
 * Retro terminal box with double border
 */
@Composable
fun TerminalBox(
    modifier: Modifier = Modifier,
    borderColor: Color = SeekerClawColors.Primary,
    content: @Composable () -> Unit,
) {
    Box(
        modifier = modifier
            .background(SeekerClawColors.Surface, RoundedCornerShape(0.dp))
            .border(2.dp, borderColor, RoundedCornerShape(0.dp))
            .padding(4.dp)
            .border(1.dp, borderColor.copy(alpha = 0.4f), RoundedCornerShape(0.dp))
            .padding(12.dp),
    ) {
        content()
    }
}

/**
 * Pixel-style primary button
 */
@Composable
fun PixelButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    color: Color = SeekerClawColors.Primary,
) {
    val bgColor = if (enabled) color.copy(alpha = 0.2f) else SeekerClawColors.Surface
    val borderColor = if (enabled) color else SeekerClawColors.TextDim
    val textColor = if (enabled) color else SeekerClawColors.TextDim

    Box(
        modifier = modifier
            .then(if (enabled) Modifier.clickable { onClick() } else Modifier)
            .background(bgColor, RoundedCornerShape(0.dp))
            .border(2.dp, borderColor, RoundedCornerShape(0.dp))
            .padding(2.dp)
            .border(1.dp, borderColor.copy(alpha = 0.5f), RoundedCornerShape(0.dp))
            .padding(horizontal = 24.dp, vertical = 14.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            fontFamily = FontFamily.Monospace,
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            color = textColor,
            letterSpacing = 2.sp,
        )
    }
}
