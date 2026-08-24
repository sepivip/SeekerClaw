package com.seekerclaw.app.util

/**
 * BAT-1247: the ONE uptime formatter for every screen.
 *
 * Pre-1247 the Dashboard rendered zero-padded "00h 03m 36s" while the System
 * screen rendered a bare "7m" for the same value one navigation hop away
 * (audit finding: "Uptime rendered in two different formats"). Both screens
 * now call this. Zero units are dropped from the left; the two most
 * significant units are shown so a live counter still ticks visibly:
 *
 *   42s            (under a minute)
 *   3m 36s         (under an hour)
 *   1h 03m         (under a day — minutes zero-padded so width is stable)
 *   2d 05h         (a day or more)
 */
object UptimeFormat {
    fun format(millis: Long): String {
        if (millis <= 0L) return "0s"
        val totalSeconds = millis / 1000
        val seconds = totalSeconds % 60
        val minutes = (totalSeconds / 60) % 60
        val hours = (totalSeconds / 3600) % 24
        val days = totalSeconds / 86400
        return when {
            days > 0 -> "${days}d %02dh".format(hours)
            hours > 0 -> "${hours}h %02dm".format(minutes)
            minutes > 0 -> "${minutes}m %02ds".format(seconds)
            else -> "${seconds}s"
        }
    }
}
