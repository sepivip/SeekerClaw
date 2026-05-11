package com.seekerclaw.app.ui.settings.wallet.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.components.cornerGlowBorder
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Sizing
import com.seekerclaw.app.ui.theme.Spacing
import com.seekerclaw.app.ui.theme.TypeScale

/**
 * KeyInputField — masked private-key paste field for the Burner Wallet
 * setup flow (BAT-582).
 *
 * **Security contract:**
 *   - Uses [PasswordVisualTransformation] so dots render in the field;
 *     the raw key value is never visible on screen even if the device's
 *     keyboard or screen reader requests it.
 *   - The parent screen MUST sit inside a [com.seekerclaw.app.ui.settings.wallet.BurnerWalletScreen]
 *     `DisposableEffect` that sets `FLAG_SECURE` on the window — this
 *     composable cannot enforce that on its own.
 *   - On paste, [onPaste] fires AFTER [onValueChange] so the parent can
 *     show the "clear clipboard" advisory. The clipboard read happens
 *     locally; the value flows into [onValueChange] in a single hop.
 *
 * Pattern is similar to [com.seekerclaw.app.ui.components.InputWithActionButton]
 * but lighter — burner setup needs only paste + a sibling Test button
 * (owned by the parent screen, since it has its own loading state and
 * post-test-success transitions).
 */
@Composable
fun KeyInputField(
    value: String,
    onValueChange: (String) -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    placeholder: String = "Paste base58 key or [1,2,3,...] JSON array",
    onPaste: () -> Unit = {},
    isError: Boolean = false,
) {
    val clipboard = LocalClipboardManager.current
    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val borderColor = if (isError) SeekerClawColors.Error else SeekerClawColors.CardBorder

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
                visualTransformation = PasswordVisualTransformation(),
                // BAT-582 R1 (security): force the IME into password mode
                // and disable autocorrect/capitalization so the OS keyboard
                // never shows pasted private-key bytes in its suggestion
                // bar / shared dictionary. PasswordVisualTransformation
                // alone hides the GLYPHS but not the KEYBOARD's preview /
                // suggestion strip — the keyboard still sees the raw
                // string and may surface it via Smart Compose, predictive
                // text learning, or accessibility services. KeyboardType
                // .Password is the documented signal to suppress all of
                // that on every Android IME.
                keyboardOptions = KeyboardOptions(
                    keyboardType = KeyboardType.Password,
                    autoCorrectEnabled = false,
                    capitalization = KeyboardCapitalization.None,
                    imeAction = ImeAction.Done,
                ),
                textStyle = TextStyle(
                    color = SeekerClawColors.TextPrimary,
                    fontSize = TypeScale.bodyMedium.value.sp,
                    fontFamily = FontFamily.Monospace,
                ),
                cursorBrush = SolidColor(SeekerClawColors.Primary),
                modifier = Modifier.fillMaxWidth(),
                decorationBox = { innerTextField ->
                    if (value.isEmpty()) {
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

        Box(
            modifier = Modifier
                .width(Sizing.borderThin)
                .fillMaxHeight()
                .background(SeekerClawColors.CardBorder),
        )

        // Paste action zone — only visible when field is empty so the user
        // doesn't accidentally append clipboard content to a partially-typed
        // entry. After paste, parent shows the "clear clipboard" advisory.
        Box(
            modifier = Modifier
                .fillMaxHeight()
                .clickable(enabled = enabled && value.isEmpty()) {
                    val pasted = clipboard.getText()?.text?.trim().orEmpty()
                    if (pasted.isNotEmpty()) {
                        onValueChange(pasted)
                        onPaste()
                    }
                }
                .padding(horizontal = Spacing.lg),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = if (value.isEmpty()) "Paste" else "•••",
                fontFamily = RethinkSans,
                fontSize = TypeScale.bodyMedium,
                fontWeight = FontWeight.Bold,
                color = if (value.isEmpty()) SeekerClawColors.TextPrimary else SeekerClawColors.TextDim,
            )
        }
    }
}

@Preview(name = "KeyInputField — empty", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun KeyInputFieldEmptyPreview() {
    KeyInputField(value = "", onValueChange = {})
}

@Preview(name = "KeyInputField — filled", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun KeyInputFieldFilledPreview() {
    KeyInputField(value = "5K6abcdef1234567890examplekey", onValueChange = {})
}

@Preview(name = "KeyInputField — error", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun KeyInputFieldErrorPreview() {
    KeyInputField(value = "bad", onValueChange = {}, isError = true)
}
