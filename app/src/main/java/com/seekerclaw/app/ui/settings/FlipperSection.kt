package com.seekerclaw.app.ui.settings

import android.Manifest
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.seekerclaw.app.flipper.BluetoothUnavailable
import com.seekerclaw.app.flipper.FlipperFirmwareGate
import com.seekerclaw.app.flipper.SecurityClass
import com.seekerclaw.app.ui.components.SeekerClawSwitch
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.SeekerClawColors
import kotlinx.coroutines.launch

/**
 * The Flipper Zero section of Settings — the only place enrollment and the allowlist can be edited.
 *
 * There is deliberately no bridge endpoint that changes any of this. The agent can read what it is
 * allowed to do and do it; changing what it is allowed to do happens here, in a foreground session,
 * or not at all (contract §3).
 *
 * Pairing itself is not here either: the Flipper shows a passkey on its own screen and Android has
 * no public API to submit one, so the user pairs in Android Settings and this works with what is
 * already bonded.
 */
@Composable
fun FlipperSection() {
    val context = LocalContext.current
    val state = remember { FlipperSettingsState(context) }
    val ui by state.ui.collectAsState()
    val scope = rememberCoroutineScope()

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { state.refresh() }

    LaunchedEffect(Unit) { state.refresh() }

    Column {
        if (!ui.hasPermission) {
            Hint(
                "SeekerClaw needs Bluetooth permission to talk to a Flipper you have already " +
                    "paired. It never scans for nearby devices.",
            )
            Spacer(Modifier.height(10.dp))
            OutlinedButton(
                onClick = { permissionLauncher.launch(Manifest.permission.BLUETOOTH_CONNECT) },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
                border = BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
            ) { Text("Grant Bluetooth permission", fontFamily = RethinkSans, fontSize = 13.sp) }
            return@Column
        }

        when (ui.bondedError) {
            BluetoothUnavailable.DISABLED -> Hint("Bluetooth is switched off. Turn it on to set up a Flipper.")
            BluetoothUnavailable.NO_ADAPTER -> Hint("This device has no Bluetooth adapter.")
            BluetoothUnavailable.PERMISSION_DENIED -> Hint("Bluetooth permission was denied.")
            null -> Unit
        }

        if (ui.enrolledAddress == null) {
            // ── Enrollment ────────────────────────────────────────────────────
            Hint(
                "Pair your Flipper Zero in Android Bluetooth settings first — it shows a code on " +
                    "its own screen. Then pick it below.",
            )
            Spacer(Modifier.height(10.dp))

            if (ui.bonded.isEmpty() && ui.bondedError == null) {
                Hint("No paired Bluetooth devices found.")
            }
            for (d in ui.bonded) {
                DeviceRow(
                    name = d.name.ifBlank { d.address },
                    subtitle = if (d.looksLikeFlipper) "Looks like a Flipper Zero" else d.address,
                    enabled = !ui.busy,
                    onClick = { scope.launch { state.enrollAndScan(d) } },
                )
            }
        } else {
            // ── Enrolled ──────────────────────────────────────────────────────
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text(
                        ui.enrolledLabel,
                        fontFamily = RethinkSans,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        color = SeekerClawColors.TextPrimary,
                    )
                    Text(
                        if (ui.firmwareVersion.isBlank()) "Firmware not identified"
                        else "Firmware ${FlipperFirmwareGate.extractVersion(ui.firmwareVersion) ?: "not identified"}",
                        fontFamily = RethinkSans,
                        fontSize = 11.sp,
                        color = SeekerClawColors.TextDim,
                    )
                }
                SeekerClawSwitch(
                    checked = ui.enabled,
                    onCheckedChange = { scope.launch { state.setEnabled(it) } },
                )
            }

            // Security notice. Informational, but IR control stays off until acknowledged.
            if (ui.securityClass != SecurityClass.OK) {
                Spacer(Modifier.height(6.dp))
                FlipperFirmwareGate.warningFor(ui.securityClass)?.let { Hint(it) }
                if (!ui.securityAcknowledged) {
                    Spacer(Modifier.height(6.dp))
                    for ((i, step) in FlipperFirmwareGate.REMEDIATION.withIndex()) {
                        Text(
                            "${i + 1}. $step",
                            fontFamily = RethinkSans,
                            fontSize = 11.sp,
                            color = SeekerClawColors.TextDim,
                            modifier = Modifier.padding(vertical = 1.dp),
                        )
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { scope.launch { state.acknowledgeSecurity() } },
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
                        border = BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
                    ) {
                        // Not "enable anyway": this records the acknowledgement and nothing else.
                        // The master switch above stays exactly as the user left it, so promising
                        // "enable" would have the button appear to do nothing on a device whose
                        // switch is off.
                        Text(
                            "I understand — continue",
                            fontFamily = RethinkSans,
                            fontSize = 13.sp,
                        )
                    }
                }
            }

            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = {
                    ui.bonded.firstOrNull { it.address == ui.enrolledAddress }
                        ?.let { d -> scope.launch { state.enrollAndScan(d) } }
                },
                enabled = !ui.busy,
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
                border = BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
            ) { Text("Read remotes from Flipper", fontFamily = RethinkSans, fontSize = 13.sp) }

            // ── Allowlist ─────────────────────────────────────────────────────
            if (ui.remotes.isNotEmpty()) {
                Spacer(Modifier.height(14.dp))
                Hint("Tick the buttons the agent may press. Nothing is enabled by default.")
                Spacer(Modifier.height(8.dp))
                for (remote in ui.remotes) {
                    Text(
                        remote.label,
                        fontFamily = RethinkSans,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = SeekerClawColors.TextPrimary,
                        modifier = Modifier.padding(top = 8.dp, bottom = 2.dp),
                    )
                    for (button in remote.buttons) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable {
                                    scope.launch {
                                        state.toggleButton(remote, button, button !in remote.selected)
                                    }
                                }
                                .padding(vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(
                                checked = button in remote.selected,
                                onCheckedChange = { scope.launch { state.toggleButton(remote, button, it) } },
                                colors = CheckboxDefaults.colors(
                                    checkedColor = SeekerClawColors.TextPrimary,
                                    uncheckedColor = SeekerClawColors.TextDim,
                                ),
                            )
                            Text(
                                button,
                                fontFamily = RethinkSans,
                                fontSize = 12.sp,
                                color = SeekerClawColors.TextSecondary,
                            )
                        }
                    }
                }
            }

            // Recent activity. The audit log exists so a user can check what the agent actually
            // did — which requires it to be visible. It was previously written and never rendered.
            val audit by state.auditEntries.collectAsState()
            if (audit.isNotEmpty()) {
                Spacer(Modifier.height(16.dp))
                Text(
                    "Recent activity",
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = SeekerClawColors.TextSecondary,
                )
                Spacer(Modifier.height(4.dp))
                for (entry in audit.take(10)) {
                    Text(
                        "${entry.formattedTime()}  ${entry.remoteLabel} / ${entry.button}  ${entry.outcome}",
                        fontFamily = RethinkSans,
                        fontSize = 10.sp,
                        color = SeekerClawColors.TextDim,
                        modifier = Modifier.padding(vertical = 1.dp),
                    )
                }
            }

            Spacer(Modifier.height(14.dp))
            OutlinedButton(
                onClick = { scope.launch { state.unenroll() } },
                modifier = Modifier.fillMaxWidth(),
                shape = RoundedCornerShape(SeekerClawColors.CornerRadius),
                border = BorderStroke(1.dp, SeekerClawColors.BorderSubtle),
            ) { Text("Forget this Flipper", fontFamily = RethinkSans, fontSize = 13.sp) }
        }

        // ── Status ────────────────────────────────────────────────────────────
        if (ui.busy) {
            Spacer(Modifier.height(10.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(
                    modifier = Modifier.size(14.dp),
                    strokeWidth = 2.dp,
                    color = SeekerClawColors.TextDim,
                )
                Spacer(Modifier.size(8.dp))
                Text(
                    ui.status ?: "Working…",
                    fontFamily = RethinkSans,
                    fontSize = 12.sp,
                    color = SeekerClawColors.TextDim,
                )
            }
        }
        ui.scanNote?.let { Spacer(Modifier.height(8.dp)); Hint(it) }
        ui.error?.let { Spacer(Modifier.height(8.dp)); Hint(it) }
    }
}

@Composable
private fun Hint(text: String) {
    Text(
        text,
        fontFamily = RethinkSans,
        fontSize = 11.sp,
        color = SeekerClawColors.TextDim,
        modifier = Modifier.fillMaxWidth(),
    )
}

@Composable
private fun DeviceRow(name: String, subtitle: String, enabled: Boolean, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled) { onClick() }
            .background(SeekerClawColors.SurfaceHighlight, RoundedCornerShape(SeekerClawColors.CornerRadius))
            .padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, fontFamily = RethinkSans, fontSize = 13.sp, color = SeekerClawColors.TextPrimary)
            Text(subtitle, fontFamily = RethinkSans, fontSize = 11.sp, color = SeekerClawColors.TextDim)
        }
    }
    Spacer(Modifier.height(6.dp))
}
