package com.seekerclaw.app.util

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay

/**
 * Composable that returns a live uptime value (millis since service
 * started) without subscribing to any disk-backed StateFlow that ticks
 * once per second.
 *
 * BAT-522 (BAT-518 phase 2) replaced the old `ServiceState.uptime`
 * StateFlow — backed by `SeekerClawService.uptimeJob` writing to disk
 * every 1s — with a one-shot start timestamp persisted in
 * `service_state` line 7. The UI now derives uptime locally:
 *
 *   - When status is RUNNING and `serviceStartTimeMs > 0`, the value
 *     is `now - serviceStartTimeMs`. The composable updates once per
 *     second so the seconds counter still animates.
 *   - Otherwise (STOPPED / ERROR / pre-BAT-522 file with no start
 *     timestamp), the value is 0L. Rendered the same way today's
 *     `formatUptime(0)` renders: "00h 00m 00s".
 *
 * The 1s tick is purely in-memory (no disk write, no StateFlow
 * propagation across processes). When status leaves RUNNING the loop
 * exits and the Composable settles at 0L.
 */
@Composable
fun rememberUptime(): Long {
    val startTimeMs by ServiceState.serviceStartTimeMs.collectAsState()
    val status by ServiceState.status.collectAsState()
    var uptime by remember { mutableLongStateOf(0L) }

    LaunchedEffect(startTimeMs, status) {
        if (status == ServiceStatus.RUNNING && startTimeMs > 0L) {
            while (true) {
                uptime = System.currentTimeMillis() - startTimeMs
                delay(1000)
            }
        } else {
            uptime = 0L
        }
    }

    return uptime
}
