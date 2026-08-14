package com.seekerclaw.app.ui.logs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Share
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.TextButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import com.seekerclaw.app.ui.components.SeekerClawSearchField
import com.seekerclaw.app.ui.components.SeekerClawSwitch
import com.seekerclaw.app.ui.components.cornerGlowBorder
import com.seekerclaw.app.ui.theme.RethinkSans
import com.seekerclaw.app.ui.theme.Sizing
import com.seekerclaw.app.ui.theme.Spacing
import com.seekerclaw.app.ui.theme.TypeScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import com.seekerclaw.app.ui.theme.SeekerClawColors
import com.seekerclaw.app.util.LogCollector
import com.seekerclaw.app.util.LogLevel
import com.seekerclaw.app.util.LogShareSanitizer
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.Date

@Composable
fun LogsScreen() {
    val context = LocalContext.current
    val haptic = LocalHapticFeedback.current
    val logs by LogCollector.logs.collectAsState()
    val listState = rememberLazyListState()
    var autoScroll by rememberSaveable { mutableStateOf(true) }

    var searchQuery by rememberSaveable { mutableStateOf("") }

    val snackbarHostState = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    // Filter toggles — rememberSaveable so they survive tab switches and config changes
    var showDebug by rememberSaveable { mutableStateOf(false) }
    var showInfo by rememberSaveable { mutableStateOf(true) }
    var showWarn by rememberSaveable { mutableStateOf(true) }
    var showError by rememberSaveable { mutableStateOf(true) }

    // BAT-513 round-22/23 device-fix: foreground-only catch-up refresh.
    // Pre-fix this was a one-shot refresh on screen open; observed on
    // Solana Seeker that LogCollector's filesDir FileObserver
    // sometimes drops deliveries, so the Logs screen stops updating
    // mid-session even while service_logs is being appended on disk.
    // While this screen is composed, refresh logs from disk every 1.5s
    // as a safety net — refreshFromFile() performs an active disk read
    // (readAllFromFile, tail-bounded to ~60 KB) AND requests a follow-
    // up drain in case more bytes landed during the read. Round-23
    // promoted this from a drain-only path because the drain depends
    // on lastReadPosition / FileObserver health; an active read works
    // regardless. Cancellation on dispose comes free with LaunchedEffect;
    // leaving the screen kills the loop. NOT a 24/7 background poll.
    // FileObserver remains the primary fast path — this fires only
    // when visible.
    LaunchedEffect(Unit) {
        while (true) {
            LogCollector.refreshFromFile()
            kotlinx.coroutines.delay(1500)
        }
    }

    val filteredLogs = remember(logs, showDebug, showInfo, showWarn, showError, searchQuery) {
        logs.filter { entry ->
            val levelMatch = when (entry.level) {
                LogLevel.DEBUG -> showDebug
                LogLevel.INFO -> showInfo
                LogLevel.WARN -> showWarn
                LogLevel.ERROR -> showError
            }
            val searchMatch = searchQuery.isBlank() ||
                entry.message.contains(searchQuery, ignoreCase = true)
            levelMatch && searchMatch
        }
    }

    val shape = RoundedCornerShape(SeekerClawColors.CornerRadius)
    val timePattern = if (android.text.format.DateFormat.is24HourFormat(context)) "HH:mm:ss" else "hh:mm:ss a"

    // Use last entry timestamp+message (not list size) so auto-scroll still works
    // when the buffer is full and size stays constant at MAX_LINES. Including message
    // handles timestamp collisions from bursty logging.
    //
    // Also include filter state (level toggles + search query) as keys: when the user
    // toggles a level filter, the filtered list changes but if the new tail entry
    // happens to match the previous tail (common when toggling adds entries above the
    // current tail), the effect wouldn't re-fire and the user would have to wait for
    // the next log event to scroll. With filter state in the keys, every filter
    // change re-fires the scroll immediately.
    val lastLog = filteredLogs.lastOrNull()
    LaunchedEffect(
        filteredLogs.size, lastLog?.timestamp, lastLog?.message, autoScroll,
        showDebug, showInfo, showWarn, showError, searchQuery,
    ) {
        if (autoScroll && filteredLogs.isNotEmpty()) {
            listState.scrollToItem(filteredLogs.size - 1)
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .background(SeekerClawColors.Background)
                .padding(20.dp),
        ) {
            // Header — bare title + share/clear actions (matches Skills/Settings tab pattern)
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Logs",
                    fontFamily = RethinkSans,
                    fontSize = TypeScale.titleLarge,
                    fontWeight = FontWeight.Bold,
                    color = SeekerClawColors.TextPrimary,
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = {
                        val logText = buildString {
                            appendLine("SeekerClaw Logs — ${java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.US).format(Date())}")
                            appendLine("─".repeat(40))
                            filteredLogs.forEach { entry ->
                                val timeStr = android.text.format.DateFormat.format(timePattern, Date(entry.timestamp))
                                appendLine("[${entry.level.name}] [$timeStr] ${entry.message}")
                            }
                        }
                        // Share second pass, defense-in-depth over the redaction already applied
                        // at LogCollector ingress (append + the parseLine restore path).
                        // LogShareSanitizer = Message-marker scrub + LogRedactor, share-only —
                        // console rendering is untouched. Secrecy-fail-CLOSED: if the sanitizer
                        // throws we must NOT fall back to the unmasked text. It is tempting to
                        // reason "the entries were already redacted, so logText is safe" — but
                        // the same redactor is what masked them, so a throw here is evidence it
                        // may have failed there too. Share is a one-tap path OFF the device; a
                        // useless export is recoverable, a leaked token is not.
                        val shareText = try { LogShareSanitizer.sanitize(logText) } catch (_: Throwable) { "[[redaction-error]]" }
                        val sendIntent = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(android.content.Intent.EXTRA_TEXT, shareText)
                            putExtra(android.content.Intent.EXTRA_SUBJECT, "SeekerClaw Logs")
                        }
                        context.startActivity(android.content.Intent.createChooser(sendIntent, "Share Logs"))
                    }) {
                        Icon(
                            Icons.Default.Share,
                            contentDescription = "Share logs",
                            tint = SeekerClawColors.TextDim,
                        )
                    }
                    // BAT-1161 P1A: "Clear console" — this only clears the service_logs mirror +
                    // in-memory ring, NOT Node's node_debug.log (which keeps recording and
                    // re-forwards). Destructive → Error tint. Undo path: the cleared entries are
                    // stashed in a local variable (no persistence) and replayed through
                    // LogCollector.append() — original timestamps preserved via eventTimeMs —
                    // which restores both the in-memory ring and the service_logs mirror, so the
                    // 1.5s refreshFromFile loop doesn't wipe the restore.
                    TextButton(onClick = {
                        val stash = logs
                        LogCollector.clear()
                        scope.launch {
                            val result = snackbarHostState.showSnackbar(
                                message = "Console cleared",
                                actionLabel = "Undo",
                                duration = SnackbarDuration.Long,
                            )
                            if (result == SnackbarResult.ActionPerformed) {
                                withContext(Dispatchers.IO) {
                                    stash.forEach { entry ->
                                        LogCollector.append(entry.message, entry.level, eventTimeMs = entry.timestamp)
                                    }
                                }
                            }
                        }
                    }) {
                        Icon(
                            Icons.Default.Delete,
                            contentDescription = "Clear console",
                            tint = SeekerClawColors.Error,
                            modifier = Modifier.size(Sizing.iconMd),
                        )
                        Spacer(modifier = Modifier.width(Spacing.xs))
                        Text(
                            text = "Clear console",
                            fontFamily = RethinkSans,
                            fontSize = TypeScale.bodySmall,
                            color = SeekerClawColors.Error,
                        )
                    }
                }
            }

            Spacer(modifier = Modifier.height(Spacing.md))

            // Search bar — THE app search field; monospace input (log queries are technical)
            SeekerClawSearchField(
                value = searchQuery,
                onValueChange = { searchQuery = it },
                placeholder = "Search logs…",
                monospaceInput = true,
            )

            Spacer(modifier = Modifier.height(Spacing.md))

            // Terminal window
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .weight(1f)
                    .background(SeekerClawColors.Surface, shape)
                    .cornerGlowBorder(),
            ) {
                if (filteredLogs.isEmpty()) {
                    Box(
                        modifier = Modifier.fillMaxSize(),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (logs.isEmpty()) {
                            // Genuine empty — no logs at all
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    text = "$ _",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 24.sp,
                                    color = SeekerClawColors.TextDim.copy(alpha = 0.4f),
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    text = "No logs yet.",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 13.sp,
                                    color = SeekerClawColors.TextDim,
                                )
                            }
                        } else {
                            // Logs exist but are all filtered out
                            val hasSearchFilter = searchQuery.isNotBlank()
                            val reasonText = when {
                                hasSearchFilter -> "No logs match your search."
                                else -> "No logs for selected levels."
                            }
                            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                                Text(
                                    text = "∅",
                                    fontSize = 28.sp,
                                    color = SeekerClawColors.TextDim.copy(alpha = 0.4f),
                                )
                                Spacer(modifier = Modifier.height(8.dp))
                                Text(
                                    text = reasonText,
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 13.sp,
                                    color = SeekerClawColors.TextDim,
                                )
                                Spacer(modifier = Modifier.height(4.dp))
                                Text(
                                    text = "${logs.size} entries hidden.",
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    color = SeekerClawColors.TextDim.copy(alpha = 0.6f),
                                )
                                Spacer(modifier = Modifier.height(12.dp))
                                TextButton(onClick = {
                                    showDebug = true
                                    showInfo = true
                                    showWarn = true
                                    showError = true
                                    searchQuery = ""
                                }) {
                                    Text(
                                        text = "Show all",
                                        fontFamily = RethinkSans,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.Bold,
                                        // BAT-1247: screen-level action = green;
                                        // red stays destructive/brand.
                                        color = SeekerClawColors.ActionPrimary,
                                    )
                                }
                            }
                        }
                    }
                } else {
                    // contentPadding (not a modifier padding) so the first line rests
                    // Spacing.sm below the card's top edge instead of clipping against
                    // it, while scrolled content still slides through the inset.
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(
                            start = Spacing.md,
                            top = Spacing.sm,
                            end = Spacing.md,
                            bottom = Spacing.sm,
                        ),
                    ) {
                        itemsIndexed(
                            filteredLogs,
                            key = { index, entry -> entry.timestamp to index },
                        ) { index, entry ->
                            val timeStr = android.text.format.DateFormat.format(timePattern, Date(entry.timestamp))
                            Text(
                                text = "[$timeStr] ${entry.message}",
                                color = logLevelColor(entry.level),
                                fontSize = TypeScale.labelSmall,
                                fontFamily = FontFamily.Monospace,
                                lineHeight = 18.sp,
                                modifier = Modifier.padding(vertical = 1.dp),
                            )
                        }
                    }
                }
            }

            // Diagnostic status line — non-spammy, always visible
            if (logs.isNotEmpty()) {
                Spacer(modifier = Modifier.height(6.dp))
                val hiddenCount = logs.size - filteredLogs.size
                val statusText = buildString {
                    append("${filteredLogs.size}/${logs.size} entries")
                    if (hiddenCount > 0) append(" · $hiddenCount filtered")
                }
                Text(
                    text = statusText,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = SeekerClawColors.TextDim.copy(alpha = 0.5f),
                )
            }

            Spacer(modifier = Modifier.height(6.dp))

            // Auto-scroll toggle
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "Auto-scroll",
                    fontFamily = RethinkSans,
                    fontSize = 14.sp,
                    color = SeekerClawColors.TextSecondary,
                )
                SeekerClawSwitch(
                    checked = autoScroll,
                    onCheckedChange = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        autoScroll = it
                    },
                )
            }

            Spacer(modifier = Modifier.height(8.dp))

            // Log level filters — active color matches the console line color per level
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip(
                    label = "Debug",
                    active = showDebug,
                    activeColor = logLevelColor(LogLevel.DEBUG),
                    shape = shape,
                    modifier = Modifier.weight(1f),
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        showDebug = !showDebug
                    },
                )
                FilterChip(
                    label = "Info",
                    active = showInfo,
                    activeColor = logLevelColor(LogLevel.INFO),
                    shape = shape,
                    modifier = Modifier.weight(1f),
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        showInfo = !showInfo
                    },
                )
                FilterChip(
                    label = "Warn",
                    active = showWarn,
                    activeColor = logLevelColor(LogLevel.WARN),
                    shape = shape,
                    modifier = Modifier.weight(1f),
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        showWarn = !showWarn
                    },
                )
                FilterChip(
                    label = "Error",
                    active = showError,
                    activeColor = logLevelColor(LogLevel.ERROR),
                    shape = shape,
                    modifier = Modifier.weight(1f),
                    onClick = {
                        haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                        showError = !showError
                    },
                )
            }
        }

        SnackbarHost(
            hostState = snackbarHostState,
            modifier = Modifier.align(Alignment.BottomCenter),
        )
    }
}

/**
 * Single source of the level → color mapping, shared by console lines and
 * filter chips. Palette roles only: INFO reads as primary prose, DEBUG is
 * de-emphasized, WARN/ERROR use the semantic roles. (Replaced the old
 * off-palette LogInfo blue.)
 */
private fun logLevelColor(level: LogLevel): Color = when (level) {
    LogLevel.DEBUG -> SeekerClawColors.TextSecondary
    LogLevel.INFO -> SeekerClawColors.TextPrimary
    LogLevel.WARN -> SeekerClawColors.Warning
    LogLevel.ERROR -> SeekerClawColors.Error
}

@Composable
private fun FilterChip(
    label: String,
    active: Boolean,
    activeColor: Color,
    shape: RoundedCornerShape,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        modifier = modifier,
        shape = shape,
        contentPadding = PaddingValues(horizontal = Spacing.sm, vertical = Spacing.sm),
        colors = ButtonDefaults.buttonColors(
            containerColor = if (active) activeColor.copy(alpha = 0.2f) else SeekerClawColors.Surface,
            contentColor = if (active) activeColor else SeekerClawColors.TextDim,
        ),
    ) {
        // Non-color selected cue (a11y): leading checkmark on active chips,
        // so selection survives color-vision differences. Inherits contentColor.
        if (active) {
            Icon(
                Icons.Default.Check,
                contentDescription = null,
                modifier = Modifier.size(Sizing.iconSm),
            )
            Spacer(modifier = Modifier.width(Spacing.xs))
        }
        Text(text = label, fontFamily = RethinkSans, fontSize = TypeScale.labelSmall, maxLines = 1, softWrap = false)
    }
}
