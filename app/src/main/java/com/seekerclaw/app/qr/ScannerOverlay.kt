package com.seekerclaw.app.qr

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.FlashOff
import androidx.compose.material.icons.filled.FlashOn
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.foundation.Canvas
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.theme.SeekerClawColors

// ============================================================================
// SCANNER OVERLAY — Themed QR scanner UI composables
// ============================================================================

private val SCAN_ZONE_SIZE = 260.dp

@Composable
fun ScannerOverlay(
    torchAvailable: Boolean,
    torchEnabled: Boolean,
    isDetected: Boolean,
    onToggleTorch: () -> Unit,
    onCancel: () -> Unit,
) {
    val transition = rememberInfiniteTransition(label = "scanner")

    val scanLineProgress by transition.animateFloat(
        initialValue = 0f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 2000, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "scanLine",
    )

    val cornerAlpha by transition.animateFloat(
        initialValue = 0.7f,
        targetValue = 1.0f,
        animationSpec = infiniteRepeatable(
            animation = tween(durationMillis = 1500, easing = LinearEasing),
            repeatMode = RepeatMode.Reverse,
        ),
        label = "cornerPulse",
    )

    Box(modifier = Modifier.fillMaxSize()) {
        // Layer 1: Vignette + viewfinder drawing
        ScannerOverlayCanvas(
            scanZoneSize = SCAN_ZONE_SIZE,
            scanLineProgress = scanLineProgress,
            cornerAlpha = cornerAlpha,
        )

        // Layer 2: Top bar
        ScannerTopBar(
            onBack = onCancel,
            torchAvailable = torchAvailable,
            torchEnabled = torchEnabled,
            onToggleTorch = onToggleTorch,
            modifier = Modifier.align(Alignment.TopCenter),
        )

        // Layer 3: Bottom status
        ScannerBottomStatus(
            isDetected = isDetected,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}

// ============================================================================
// CANVAS — Vignette mask, corner brackets, scan line, crosshair
// ============================================================================

@Composable
private fun ScannerOverlayCanvas(
    scanZoneSize: Dp,
    scanLineProgress: Float,
    cornerAlpha: Float,
) {
    val density = LocalDensity.current
    val zonePx = with(density) { scanZoneSize.toPx() }
    val bracketLen = with(density) { 32.dp.toPx() }
    val bracketWidth = with(density) { 3.dp.toPx() }
    val crosshairArm = with(density) { 20.dp.toPx() }
    val glowOffset = with(density) { 4.dp.toPx() }

    val vignetteColor = SeekerClawColors.Background.copy(alpha = 0.7f)
    val bracketColor = SeekerClawColors.Primary
    val scanLineColor = SeekerClawColors.Primary.copy(alpha = 0.6f)
    val scanGlowColor = SeekerClawColors.Primary.copy(alpha = 0.15f)
    val crosshairColor = SeekerClawColors.TextDim.copy(alpha = 0.4f)

    Canvas(
        modifier = Modifier
            .fillMaxSize()
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
    ) {
        val canvasW = size.width
        val canvasH = size.height

        // Scan zone rect (centered)
        val zoneLeft = (canvasW - zonePx) / 2f
        val zoneTop = (canvasH - zonePx) / 2f
        val zoneRect = Rect(zoneLeft, zoneTop, zoneLeft + zonePx, zoneTop + zonePx)

        // --- Vignette mask with clear cutout ---
        drawRect(color = vignetteColor)
        drawRect(
            color = Color.Transparent,
            topLeft = Offset(zoneRect.left, zoneRect.top),
            size = Size(zonePx, zonePx),
            blendMode = BlendMode.Clear,
        )

        // --- Corner brackets (4 L-shapes) ---
        val bColor = bracketColor.copy(alpha = cornerAlpha)

        fun drawCornerBracket(corner: Offset, hSign: Float, vSign: Float) {
            drawLine(bColor, corner, Offset(corner.x + hSign * bracketLen, corner.y), bracketWidth, StrokeCap.Round)
            drawLine(bColor, corner, Offset(corner.x, corner.y + vSign * bracketLen), bracketWidth, StrokeCap.Round)
        }

        drawCornerBracket(Offset(zoneRect.left, zoneRect.top), 1f, 1f)      // Top-left
        drawCornerBracket(Offset(zoneRect.right, zoneRect.top), -1f, 1f)     // Top-right
        drawCornerBracket(Offset(zoneRect.left, zoneRect.bottom), 1f, -1f)   // Bottom-left
        drawCornerBracket(Offset(zoneRect.right, zoneRect.bottom), -1f, -1f) // Bottom-right

        // --- Scan line (horizontal sweep) ---
        val lineY = zoneRect.top + (zonePx * scanLineProgress)
        // Glow above
        drawLine(scanGlowColor, Offset(zoneRect.left, lineY - glowOffset), Offset(zoneRect.right, lineY - glowOffset), bracketWidth)
        // Main line
        drawLine(scanLineColor, Offset(zoneRect.left, lineY), Offset(zoneRect.right, lineY), bracketWidth)
        // Glow below
        drawLine(scanGlowColor, Offset(zoneRect.left, lineY + glowOffset), Offset(zoneRect.right, lineY + glowOffset), bracketWidth)

        // --- Crosshair (center) ---
        val cx = canvasW / 2f
        val cy = canvasH / 2f
        drawLine(crosshairColor, Offset(cx - crosshairArm / 2f, cy), Offset(cx + crosshairArm / 2f, cy), 1.dp.toPx())
        drawLine(crosshairColor, Offset(cx, cy - crosshairArm / 2f), Offset(cx, cy + crosshairArm / 2f), 1.dp.toPx())
    }
}

// ============================================================================
// TOP BAR — Back arrow, //SCAN title, torch toggle
// ============================================================================

@Composable
private fun ScannerTopBar(
    onBack: () -> Unit,
    torchAvailable: Boolean,
    torchEnabled: Boolean,
    onToggleTorch: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Background.copy(alpha = 0.85f))
            .statusBarsPadding()
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        // Back arrow
        IconButton(onClick = onBack) {
            Icon(
                imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                contentDescription = "Back",
                tint = SeekerClawColors.TextPrimary,
            )
        }

        // Title
        Text(
            text = "//SCAN",
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.Bold,
            fontSize = 16.sp,
            color = SeekerClawColors.Primary,
            letterSpacing = 2.sp,
        )

        // Torch toggle
        if (torchAvailable) {
            IconButton(onClick = onToggleTorch) {
                Icon(
                    imageVector = if (torchEnabled) Icons.Filled.FlashOn else Icons.Filled.FlashOff,
                    contentDescription = if (torchEnabled) "Torch on" else "Torch off",
                    tint = if (torchEnabled) SeekerClawColors.Warning else SeekerClawColors.TextDim,
                )
            }
        } else {
            // Invisible spacer to keep title centered
            Spacer(modifier = Modifier.size(48.dp))
        }
    }
}

// ============================================================================
// BOTTOM STATUS — Instruction text + hint
// ============================================================================

@Composable
private fun ScannerBottomStatus(
    isDetected: Boolean,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(SeekerClawColors.Background.copy(alpha = 0.85f))
            .navigationBarsPadding()
            .padding(horizontal = 16.dp, vertical = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = if (isDetected) "QR Detected" else "Align QR code in frame",
            fontFamily = FontFamily.Monospace,
            fontSize = 13.sp,
            color = if (isDetected) SeekerClawColors.Accent else SeekerClawColors.TextSecondary,
            letterSpacing = 1.sp,
        )
        Spacer(modifier = Modifier.height(4.dp))
        Text(
            text = "seekerclaw.xyz/quick-setup",
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            color = SeekerClawColors.TextDim,
        )
    }
}
