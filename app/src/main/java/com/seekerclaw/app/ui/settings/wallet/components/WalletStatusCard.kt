package com.seekerclaw.app.ui.settings.wallet.components

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.ui.components.CardSurface
import com.seekerclaw.app.ui.components.InfoRow
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.ui.theme.Spacing

/**
 * WalletStatusCard — reusable wallet info card (BAT-582).
 *
 * Shows role label, truncated pubkey with tap-to-copy, balances, and
 * today's spend. Designed generically so future Main wallet status cards
 * (Phase 5+) can use the same composable.
 *
 * Tap-to-copy uses system [ClipboardManager] directly (we want to expose
 * the full address, not the truncated one). Confirmation has two channels
 * (R4 review fix — earlier KDoc said "without a popup" which mismatched
 * the actual code path):
 *   - Long-press haptic via [HapticFeedbackType.LongPress] for tactile
 *     feedback that the tap registered.
 *   - A short [Toast] reading "Address copied" — chosen because some
 *     users won't notice the haptic (vibration off, in-pocket copy from
 *     a paired Bluetooth keyboard, etc.) and silent copies of a wallet
 *     address are an easy way to ship the wrong address by accident.
 *
 * If a future redesign opts for haptic-only, drop the `Toast.makeText`
 * call in [copyToClipboard] and update this KDoc in the same change.
 */
@Composable
fun WalletStatusCard(
    role: String,
    fullAddress: String,
    balanceSol: String,
    balanceUsdc: String,
    spentTodaySol: String,
    spentTodayUsdc: String,
    remainingDailySol: String,
    remainingDailyUsdc: String,
    modifier: Modifier = Modifier,
    onRefresh: (() -> Unit)? = null,
    isRefreshing: Boolean = false,
) {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current

    CardSurface(modifier = modifier) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = role,
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    fontWeight = FontWeight.ExtraBold,
                    color = SeekerClawColors.TextPrimary,
                )
                if (onRefresh != null) {
                    Spacer(Modifier.width(Spacing.xs))
                    // Refresh affordance — small icon button next to role.
                    // While [isRefreshing], replace the icon with a spinner
                    // and disable taps so a slow RPC call can't be re-fired
                    // mid-flight (each tap is a real network round-trip and
                    // the user has no other signal that one is in progress).
                    Box(
                        modifier = Modifier.size(28.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (isRefreshing) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(14.dp),
                                color = SeekerClawColors.TextInteractive,
                                strokeWidth = 1.5.dp,
                            )
                        } else {
                            IconButton(
                                onClick = {
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    onRefresh()
                                },
                                modifier = Modifier.size(28.dp),
                            ) {
                                Icon(
                                    imageVector = Icons.Filled.Refresh,
                                    contentDescription = "Refresh balance",
                                    tint = SeekerClawColors.TextInteractive,
                                    modifier = Modifier.size(16.dp),
                                )
                            }
                        }
                    }
                }
            }
            // Truncated pubkey + tap-to-copy
            Row(
                modifier = Modifier.clickable {
                    // BAT-582 R1: pass the role through to the clipboard
                    // label so this composable stays generic — pre-fix it
                    // hard-coded "burner address" but the card is shared
                    // with the Main wallet preview (and any future role).
                    copyToClipboard(context, fullAddress, role)
                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = truncate(fullAddress),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    color = SeekerClawColors.TextSecondary,
                )
                // BAT-582 R3: small horizontal gap between truncated address
                // and the "Copy" affordance. Pre-fix used Spacer(height(0.dp))
                // inside a Row, which is a no-op (height adds vertical space,
                // not horizontal — this is a Row). Use width() with the M3
                // sm token (8.dp) to match the spacing scale used elsewhere.
                Spacer(Modifier.width(Spacing.sm))
                Text(
                    text = "Copy",
                    fontFamily = RethinkSans,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextInteractive,
                )
            }
        }

        Spacer(Modifier.height(Spacing.md))

        InfoRow(label = "Balance (SOL)", value = balanceSol)
        InfoRow(label = "Balance (USDC)", value = balanceUsdc)
        InfoRow(label = "Spent today (SOL)", value = spentTodaySol)
        InfoRow(label = "Spent today (USDC)", value = spentTodayUsdc)
        InfoRow(label = "Remaining today (SOL)", value = remainingDailySol)
        InfoRow(label = "Remaining today (USDC)", value = remainingDailyUsdc, isLast = true)
    }
}

/**
 * Internal copy helper. Exposed (vs private) so other burner-wallet
 * components in this package can reuse the same Toast + clipboard label
 * convention. Kept package-internal — not part of any public UI API.
 */
internal fun copyToClipboard(context: Context, value: String, role: String) {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    // Use the role text (e.g. "Burner wallet", "Main wallet") as the clip
    // label so OS clipboard managers / paste pickers identify which wallet
    // address was copied. Falls back to "wallet address" if the caller
    // passed an empty role.
    val label = if (role.isNotBlank()) "$role address" else "wallet address"
    cm.setPrimaryClip(ClipData.newPlainText(label, value))
    Toast.makeText(context, "Address copied", Toast.LENGTH_SHORT).show()
}

/**
 * Truncates a Solana pubkey for display: first 4 + "…" + last 4.
 * Pubkeys are base58, ~44 chars; the abbreviated form is the standard
 * convention across Phantom, Solscan, etc.
 */
internal fun truncate(address: String): String {
    if (address.length <= 12) return address
    return "${address.take(4)}…${address.takeLast(4)}"
}

@Preview(name = "WalletStatusCard", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun WalletStatusCardPreview() {
    WalletStatusCard(
        role = "Burner wallet",
        fullAddress = "7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        balanceSol = "0.0500",
        balanceUsdc = "5.00",
        spentTodaySol = "0.0100",
        spentTodayUsdc = "1.00",
        remainingDailySol = "0.4900",
        remainingDailyUsdc = "49.00",
        onRefresh = {},
        isRefreshing = false,
    )
}

@Preview(name = "WalletStatusCard — refreshing", showBackground = true, backgroundColor = 0xFF0D0D0D)
@Composable
private fun WalletStatusCardRefreshingPreview() {
    WalletStatusCard(
        role = "Burner wallet",
        fullAddress = "7xKXTg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        balanceSol = "0.0500",
        balanceUsdc = "5.00",
        spentTodaySol = "0.0100",
        spentTodayUsdc = "1.00",
        remainingDailySol = "0.4900",
        remainingDailyUsdc = "49.00",
        onRefresh = {},
        isRefreshing = true,
    )
}
