package com.seekerclaw.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
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
 * Setup step indicator — numbered circles with labels and connecting lines
 */
@Composable
fun SetupStepIndicator(
    currentStep: Int,
    labels: List<String>,
    modifier: Modifier = Modifier,
    circleSize: Dp = 32.dp,
    stepWidth: Dp = 48.dp,
    connectorHeight: Dp = 2.dp,
) {
    val totalSteps = labels.size
    val connectorTopPadding = (circleSize.value / 2).dp - (connectorHeight / 2)

    Row(
        modifier = modifier.fillMaxWidth(),
        verticalAlignment = Alignment.Top,
    ) {
        for (i in 0 until totalSteps) {
            val isCompleted = i < currentStep
            val isCurrent = i == currentStep

            // Step column (circle + label)
            Column(
                horizontalAlignment = Alignment.CenterHorizontally,
                modifier = Modifier.width(stepWidth),
            ) {
                Box(
                    modifier = Modifier
                        .size(circleSize)
                        .background(
                            color = when {
                                isCompleted -> SeekerClawColors.Accent
                                isCurrent -> SeekerClawColors.Primary
                                else -> SeekerClawColors.Surface
                            },
                            shape = CircleShape,
                        )
                        .then(
                            if (!isCompleted && !isCurrent)
                                Modifier.border(1.dp, SeekerClawColors.TextDim.copy(alpha = 0.4f), CircleShape)
                            else Modifier
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    if (isCompleted) {
                        Text(
                            text = "\u2713",
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Bold,
                            color = SeekerClawColors.TextPrimary,
                        )
                    } else {
                        Text(
                            text = "${i + 1}",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Bold,
                            color = if (isCurrent) SeekerClawColors.TextPrimary else SeekerClawColors.TextDim,
                        )
                    }
                }

                Spacer(modifier = Modifier.height(6.dp))

                Text(
                    text = labels[i],
                    fontSize = 10.sp,
                    fontWeight = if (isCurrent) FontWeight.Medium else FontWeight.Normal,
                    color = if (isCurrent || isCompleted) SeekerClawColors.TextPrimary
                            else SeekerClawColors.TextDim,
                    textAlign = TextAlign.Center,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }

            // Connecting line between steps
            if (i < totalSteps - 1) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .padding(top = connectorTopPadding)
                        .height(connectorHeight)
                        .background(
                            if (i < currentStep) SeekerClawColors.Accent
                            else SeekerClawColors.TextDim.copy(alpha = 0.2f)
                        ),
                )
            }
        }
    }
}
